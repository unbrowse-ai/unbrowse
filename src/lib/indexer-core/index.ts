import { buildSkillOperationGraph } from "../graph-core/index.js";
import { validateManifest, publishSkill, cachePublishedSkill, publishGraphEdges } from "../../client/index.js";
import { mergeEndpoints } from "../../marketplace/index.js";
import {
  selectMarketplacePublishClosure,
  formatMarketplacePublishSelection,
} from "../../publish-admission.js";
import {
  writeSkillSnapshot,
  domainSkillCache,
  persistDomainCache,
  getDomainReuseKey,
  scopedCacheKey,
  snapshotPathForCacheKey,
  generateLocalDescription,
} from "../../orchestrator/index.js";
import { getRegistrableDomain } from "../../domain.js";
import type { EndpointReviewPayload, SkillManifest, EndpointDescriptor } from "../../types/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeForPublish } from "../../publish/sanitize.js";
import { readWorkflowArtifact } from "../../workflow/artifact.js";
import { buildWorkflowPublishArtifact, writeWorkflowPublishArtifact } from "../../workflow/publish.js";
import { getUnbrowseConfigPath } from "../../settings.js";
import { getEndpointDescriptionMetadata } from "../graph-core/index.js";
import { applyBindingReviews, applyResponseSchemaReviews } from "../../publish/schema-review.js";
import { getContributionConfig } from "../../config/contribution.js";
import { writeJob, listJobs, heartbeatAgeMs, tryAcquireWorkerSlot, sanitizeDomain, type JobEnvelope } from "./queue-store.js";

const SKILL_SNAPSHOT_DIR = process.env.UNBROWSE_SKILL_SNAPSHOT_DIR
  ?? join(process.env.HOME ?? "/tmp", ".unbrowse", "skill-snapshots");

function getQueueDir(): string {
  return join(process.env.HOME ?? "/tmp", ".unbrowse", "queue", "pending");
}

/** Heartbeat coalesce: if a drain worker touched the queue dir within the last
 * ~2 seconds, assume it's still alive and skip spawning another. */
async function isWorkerActive(queueDir: string): Promise<boolean> {
  try {
    const age = await heartbeatAgeMs(queueDir);
    return age < 2000;
  } catch {
    return false;
  }
}

/** Read agent_id from local config — used for contributor attribution on publish. */
function getLocalAgentId(): string | undefined {
  try {
    const config = JSON.parse(readFileSync(getUnbrowseConfigPath(), "utf-8"));
    return config.agent_id ?? undefined;
  } catch {
    return undefined;
  }
}
/**
 * Strip PII and user-specific data from endpoints before publishing to marketplace.
 * Keeps: URL templates, method, schema structure, semantic metadata (action/resource kinds,
 *        requires/provides, field paths, descriptions).
 * Strips: example response data, actual query values, sample URLs with query params,
 *         request bodies, header values.
 */
/**
 * Strip PII and user-specific data from endpoints before publishing to marketplace.
 * Deterministic baseline — the agent sanitizer builds on top of this.
 */

/**
 * Merge agent-reviewed endpoint metadata into sanitized endpoints.
 * Called by the /v1/skills/:id/review route when an agent submits
 * reviewed descriptions and synthetic examples for a skill's endpoints.
 */
export function mergeAgentReview(
  endpoints: EndpointDescriptor[],
  reviews: EndpointReviewPayload[],
): EndpointDescriptor[] {
  const reviewMap = new Map(reviews.map((r) => [r.endpoint_id, r]));
  return endpoints.map((ep) => {
    const reviewed = reviewMap.get(ep.endpoint_id);
    if (!reviewed) return ep;
    const responseSchema = applyResponseSchemaReviews(ep.response_schema, reviewed.response_reviews);
    return {
      ...ep,
      description: reviewed.description || ep.description,
      ...(responseSchema ? { response_schema: responseSchema } : {}),
      semantic: ep.semantic ? {
        ...ep.semantic,
        action_kind: reviewed.action_kind || ep.semantic.action_kind,
        resource_kind: reviewed.resource_kind || ep.semantic.resource_kind,
        description_out: reviewed.description || ep.semantic.description_out,
        description_source: reviewed.description ? "agent" : ep.semantic.description_source,
        description_needs_review: reviewed.description ? false : ep.semantic.description_needs_review,
        ...(reviewed.description ? { description_warning: undefined } : {}),
        ...(reviewed.example_response ? { example_response_compact: reviewed.example_response } : {}),
        ...(reviewed.example_request ? { example_request: reviewed.example_request } : {}),
        ...(reviewed.parameter_reviews?.length ? {
          requires: applyBindingReviews(ep.semantic.requires, reviewed.parameter_reviews),
        } : {}),
      } : ep.semantic,
    };
  });
}
/**
 * Find existing domain snapshots and merge incoming endpoints into them.
 * Returns a merged skill with all endpoints from both existing snapshots
 * and the incoming skill, or null if no existing snapshot found.
 */
export function findAndMergeDomainSnapshot(
  snapshotDir: string,
  domain: string,
  incoming: SkillManifest,
): SkillManifest | null {
  if (!existsSync(snapshotDir)) return null;
  const targetDomain = getRegistrableDomain(domain);

  let bestExisting: SkillManifest | null = null;
  let bestEndpointCount = 0;

  for (const entry of readdirSync(snapshotDir)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const candidate = JSON.parse(readFileSync(join(snapshotDir, entry), "utf-8")) as SkillManifest;
      if (getRegistrableDomain(candidate.domain) !== targetDomain) continue;
      if (candidate.execution_type !== "http") continue;
      const epCount = candidate.endpoints?.length ?? 0;
      if (epCount > bestEndpointCount) {
        bestExisting = candidate;
        bestEndpointCount = epCount;
      }
    } catch { /* skip corrupt */ }
  }

  if (!bestExisting) return null;

  const merged = mergeEndpoints(bestExisting.endpoints, incoming.endpoints);
  if (merged.length <= bestEndpointCount) return null; // no new endpoints to add

  return {
    ...bestExisting,
    endpoints: merged,
    intents: Array.from(new Set([
      ...(bestExisting.intents ?? []),
      ...(incoming.intents ?? []),
      incoming.intent_signature,
    ])),
    updated_at: new Date().toISOString(),
  };
}
const indexInFlight = new Map<string, Promise<void>>();
const pendingIndexJobs = new Map<string, BackgroundIndexJob>();

type BackgroundIndexProcessor = (job: BackgroundIndexJob) => Promise<void>;
let backgroundIndexProcessor: BackgroundIndexProcessor = processIndexJob;

function shouldRunInline(): boolean {
  if (process.env.UNBROWSE_INLINE_INDEX === "1") return true;
  return backgroundIndexProcessor !== processIndexJob;
}

export interface BackgroundIndexJob {
  skill: SkillManifest;
  domain: string;
  intent: string;
  contextUrl?: string;
  clientScope?: string;
  cacheKey: string;
  publishAfterIndex?: boolean;
}

export interface IndexedSkillState {
  skill: SkillManifest;
  domain: string;
  clientScope?: string;
  scopedKey: string;
}

/**
 * Queue a skill for background processing: local graph/export indexing and,
 * only when explicitly requested, remote marketplace publish/share.
 * Non-blocking — returns immediately.
 * Per-domain coalescing: only one job per domain runs at a time, while the
 * latest pending work for that domain is merged and replayed after the active
 * job completes.
 */
export function queueBackgroundIndex(job: BackgroundIndexJob): void {
  if (shouldRunInline()) {
    const key = job.domain;
    if (indexInFlight.has(key)) {
      const pending = pendingIndexJobs.get(key);
      pendingIndexJobs.set(key, pending ? mergeBackgroundIndexJobs(pending, job) : job);
      console.error(`[capture-pipeline] coalesced pending job for ${key}: already in flight`);
      return;
    }

    const work = backgroundIndexProcessor(job)
      .catch(err =>
        console.error(`[capture-pipeline] failed for ${key}: ${(err as Error).message}`)
      )
      .finally(() => {
        indexInFlight.delete(key);
        const pending = pendingIndexJobs.get(key);
        if (pending) {
          pendingIndexJobs.delete(key);
          console.error(`[capture-pipeline] replaying coalesced job for ${key}`);
          queueBackgroundIndex(pending);
        }
      });

    indexInFlight.set(key, work);
    console.error(
      `[capture-pipeline] queued for ${key}`
        + (job.publishAfterIndex ? " (index+publish)" : " (index-only)"),
    );
    return;
  }

  // Disk path (Day 6): write envelope, then spawn detached drain worker
  // unless a heartbeat says one is already active (<2s old).
  const queueDir = getQueueDir();
  const envelope: JobEnvelope = {
    version: 1,
    domain: job.domain,
    queuedAt: Date.now(),
    attempts: 0,
    job,
  };
  writeJob(queueDir, envelope)
    .then(async () => {
      if (await isWorkerActive(queueDir)) return;
      // Phase 1.1 Day 5 (Model B): gate the spawn on the global worker slot.
      // If another worker holds the slot, skip the spawn entirely. Otherwise
      // parent holds the slot just long enough to spawn; the child re-acquires
      // on its own startup and becomes the canonical holder for its lifetime.
      const slot = await tryAcquireWorkerSlot(queueDir);
      if (slot === null) return;
      try {
        const { spawn } = await import("node:child_process");
        const entry = process.argv[1] ?? "";
        if (!entry) {
          console.error("[capture-pipeline] cannot spawn drain worker: missing argv[1]");
          return;
        }
        const child = spawn(process.execPath, [entry, "__drain-queue"], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } catch (err) {
        console.error(`[capture-pipeline] drain worker spawn failed: ${(err as Error).message}`);
      } finally {
        await slot();
      }
    })
    .catch(err =>
      console.error(`[capture-pipeline] queue write failed: ${(err as Error).message}`),
    );
}

export function mergeBackgroundIndexJobs(
  current: BackgroundIndexJob,
  incoming: BackgroundIndexJob,
): BackgroundIndexJob {
  const mergedSkill: SkillManifest = {
    ...current.skill,
    ...incoming.skill,
    endpoints: mergeEndpoints(current.skill.endpoints, incoming.skill.endpoints),
    intents: Array.from(new Set([
      ...(current.skill.intents ?? []),
      ...(incoming.skill.intents ?? []),
      current.skill.intent_signature,
      incoming.skill.intent_signature,
    ].filter(Boolean))),
    updated_at: incoming.skill.updated_at ?? new Date().toISOString(),
    ...(incoming.skill.auth_profile_ref || current.skill.auth_profile_ref
      ? { auth_profile_ref: incoming.skill.auth_profile_ref ?? current.skill.auth_profile_ref }
      : {}),
  };

  return {
    ...current,
    ...incoming,
    skill: mergedSkill,
    domain: incoming.domain,
    intent: incoming.intent,
    contextUrl: incoming.contextUrl ?? current.contextUrl,
    clientScope: incoming.clientScope ?? current.clientScope,
    cacheKey: incoming.cacheKey,
    publishAfterIndex: incoming.publishAfterIndex ?? current.publishAfterIndex,
  };
}

function persistIndexedSkillState(
  job: BackgroundIndexJob,
  skill: SkillManifest,
  scopedKey: string,
): void {
  try { cachePublishedSkill(skill, job.clientScope); } catch { /* best-effort */ }
  writeSkillSnapshot(scopedKey, skill);
  writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(
    skill,
    readWorkflowArtifact(skill.skill_id),
    { publishStatus: "indexed" },
  ));

  const domainKey = getDomainReuseKey(job.contextUrl ?? job.domain);
  if (domainKey) {
    domainSkillCache.set(domainKey, {
      skillId: skill.skill_id,
      localSkillPath: snapshotPathForCacheKey(scopedKey),
      ts: Date.now(),
    });
    persistDomainCache();
  }
}

export async function indexSkillLocally(job: BackgroundIndexJob): Promise<IndexedSkillState> {
  let { skill, domain, clientScope } = job;
  const scope = clientScope ?? "global";
  const scopedKey = scopedCacheKey(scope, job.cacheKey);

  // 0. Merge with existing domain snapshot (accumulate endpoints across captures)
  const merged = findAndMergeDomainSnapshot(SKILL_SNAPSHOT_DIR, domain, skill);
  if (merged) {
    console.error(`[capture-pipeline] merged ${skill.endpoints.length} new endpoint(s) into existing ${merged.endpoints.length - skill.endpoints.length} for ${domain}`);
    skill = merged;
  }

  // 1. Build operation graph from ALL accumulated endpoints
  skill.operation_graph = buildSkillOperationGraph(skill.endpoints);

  // 2. Generate local descriptions for BM25 ranking
  for (const ep of skill.endpoints) {
    if (!ep.description) {
      ep.description = generateLocalDescription(ep);
    }
  }

  // 3. Persist local indexed state and an indexed workflow export.
  persistIndexedSkillState(job, skill, scopedKey);
  return { skill, domain, clientScope, scopedKey };
}

export async function publishIndexedSkill(indexed: IndexedSkillState): Promise<{
  published: boolean;
  publishStatus: "indexed" | "blocked-validation" | "published";
  publishedSkill?: SkillManifest;
  publishedAt?: string;
  validationErrors?: string[];
}> {
  const { skill, domain, clientScope, scopedKey } = indexed;
  const selection = selectMarketplacePublishClosure(skill);
  const markBlockedValidation = (errors: string[]) => {
    writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(
      skill,
      readWorkflowArtifact(skill.skill_id),
      {
        publishStatus: "blocked-validation",
        validationErrors: errors,
        endpointIds: selection.closure_endpoint_ids,
        rootEndpointIds: selection.root_endpoint_ids,
      },
    ));
    return {
      published: false as const,
      publishStatus: "blocked-validation" as const,
      validationErrors: errors,
    };
  };
  if (selection.endpoints.length === 0) {
    console.log(
      `[capture-pipeline] remote publish skipped for ${domain}: no admitted endpoints (${formatMarketplacePublishSelection(selection)})`,
    );
    return { published: false, publishStatus: "indexed" };
  }
  console.log(
    `[capture-pipeline] remote publish ${selection.endpoints.length}/${selection.stats.total} endpoint(s) for ${domain} (${selection.root_endpoint_ids.length} roots, ${selection.endpoints.length - selection.root_endpoint_ids.length} closure) (${formatMarketplacePublishSelection(selection)})`,
  );

  const unreviewedSelection = selection.endpoints
    .map((endpoint) => ({
      endpoint,
      descriptionMeta: getEndpointDescriptionMetadata(endpoint),
    }))
    .filter(({ descriptionMeta }) => descriptionMeta.needs_review);
  if (unreviewedSelection.length > 0) {
    const errors = unreviewedSelection.map(({ endpoint, descriptionMeta }) =>
      `review_required:${endpoint.endpoint_id}:${descriptionMeta.display || "missing_description"}`,
    );
    console.warn(
      `[capture-pipeline] remote publish blocked for ${domain}: ${unreviewedSelection.length} endpoint(s) still need review`,
    );
    return markBlockedValidation(errors);
  }

  const sanitized = sanitizeForPublish(selection.endpoints);

  const { operation_graph: _g, ...base } = skill;
  const draft: SkillManifest = { ...base, endpoints: sanitized, indexer_id: getLocalAgentId() };
  let validation;
  try {
    validation = await validateManifest({ ...draft, skill_id: "__validate__" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[capture-pipeline] remote publish validation failed for ${domain}: ${message}`);
    return markBlockedValidation([message]);
  }
  if (!validation.valid) {
    console.warn(
      `[capture-pipeline] remote publish blocked for ${domain}: ${validation.hardErrors.join("; ")}`
    );
    return markBlockedValidation(validation.hardErrors);
  }

  const publishStart = Date.now();
  let published;
  try {
    published = await publishSkill(draft);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[capture-pipeline] remote publish failed for ${domain}: ${message}`);
    return markBlockedValidation([message]);
  }
  const publishMs = Date.now() - publishStart;
  console.error(`[capture-pipeline] remote publish latency: ${publishMs}ms for ${domain}`);

  const publishedSkill: SkillManifest = {
    ...published,
    endpoints: skill.endpoints,
    operation_graph: skill.operation_graph,
    ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
  };

  cachePublishedSkill(publishedSkill, clientScope);
  writeSkillSnapshot(scopedKey, publishedSkill);
  const publishedAt = new Date().toISOString();
  writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(
    skill,
    readWorkflowArtifact(skill.skill_id),
    {
      publishStatus: "published",
      publishedAt,
      endpointIds: selection.closure_endpoint_ids,
      rootEndpointIds: selection.root_endpoint_ids,
    },
  ));

  if (skill.operation_graph?.operations) {
    for (const op of skill.operation_graph.operations) {
      if (!selection.closure_operation_ids.includes(op.operation_id)) continue;
      const opEdges = (skill.operation_graph.edges ?? [])
        .filter(e => e.from_operation_id === op.operation_id && selection.closure_operation_ids.includes(e.to_operation_id))
        .map(e => ({
          target_endpoint_id: skill.operation_graph!.operations.find(
            t => t.operation_id === e.to_operation_id
          )?.endpoint_id ?? e.to_operation_id,
          kind: e.kind,
          confidence: e.confidence,
        }));
      if (opEdges.length > 0) {
        publishGraphEdges(domain, {
          endpoint_id: op.endpoint_id,
          method: op.method,
          url_template: op.url_template,
        }, opEdges).catch(() => {});
      }
    }
  }

  const domainKey = getDomainReuseKey(domain);
  if (domainKey) {
    domainSkillCache.set(domainKey, {
      skillId: publishedSkill.skill_id,
      localSkillPath: snapshotPathForCacheKey(scopedKey),
      ts: Date.now(),
    });
    persistDomainCache();
  }

  console.error(`[capture-pipeline] remote publish completed for ${domain} -> ${published.skill_id}`);
  return {
    published: true,
    publishStatus: "published",
    publishedSkill,
    publishedAt,
  };
}

/**
 * Pure predicate for the index→publish gate. Two doors:
 *   1. `share_pointers` (opt-out flag): false → user has removed themselves
 *      from the public marketplace; nothing publishes.
 *   2. `reviewed_at` (review-gate): missing → skill carries heuristic
 *      descriptions; held back unless `auto_review` is true. The review
 *      handler stamps `reviewed_at` and re-runs this predicate.
 *
 * `auto_review=true` short-circuits door 2: heuristic-described skills are
 * accepted as-is and publish WITHOUT a `reviewed_at` stamp. `reviewed_at`
 * is provenance — it records that an actual `unbrowse_review` happened —
 * so auto-published manifests must never carry it.
 *
 * Returns the decision plus a human-readable reason that callers can log
 * or surface to the agent. Exported so unit tests can exercise all doors
 * without invoking the network-bound publishIndexedSkill path.
 */
export function shouldPublishAfterIndex(
  skill: { reviewed_at?: string; skill_id?: string },
  contribution: { share_pointers: boolean; auto_review?: boolean },
): { publish: boolean; visibility: "public" | "private"; gate: "ok" | "share_pointers_off" | "awaiting_review" | "auto_review"; reason: string } {
  if (!contribution.share_pointers) {
    // Opt-out no longer DROPS the capture. It's stored PRIVATELY to the user's own
    // account (visibility:"private") so it appears in their captured routes and can be
    // submitted to the public marketplace later — for money — from the dashboard. We
    // still publish (so the backend persists it under the user's agent), just private.
    return {
      publish: true,
      visibility: "private",
      gate: "share_pointers_off",
      reason: "private mode — stored privately to your account; submit it later from the dashboard to earn x402 rewards.",
    };
  }
  if (!skill.reviewed_at) {
    if (contribution.auto_review) {
      return {
        publish: true,
        visibility: "public",
        gate: "auto_review",
        reason: "auto_review=true: heuristic + LLM-augmented descriptions accepted as-is.",
      };
    }
    return {
      publish: false,
      visibility: "private",
      gate: "awaiting_review",
      reason: "awaiting review — call unbrowse_review to describe endpoints and publish, set auto_review=true via unbrowse_settings to skip review, or set share_pointers=false to stay private.",
    };
  }
  return {
    publish: true,
    visibility: "public",
    gate: "ok",
    reason: "reviewed + share_pointers=true",
  };
}

async function processIndexJob(job: BackgroundIndexJob): Promise<void> {
  // auto_review publishes through the gate's auto_review door WITHOUT
  // stamping reviewed_at — that field records an actual unbrowse_review,
  // and forging it here would make unreviewed manifests claim review.
  const { contribution } = getContributionConfig();

  const indexed = await indexSkillLocally(job);
  console.error(`[capture-pipeline] local index completed for ${indexed.domain} -> ${indexed.skill.skill_id}`);

  if (!job.publishAfterIndex) {
    console.error(`[capture-pipeline] remote publish not queued for ${indexed.domain}`);
    return;
  }

  const decision = shouldPublishAfterIndex(indexed.skill, contribution);
  if (!decision.publish) {
    console.error(
      `[capture-pipeline] ${decision.gate} — skipping marketplace publish for skill ${indexed.skill.skill_id} (${indexed.domain}): ${decision.reason}`,
    );
    return;
  }
  if (decision.gate === "auto_review") {
    console.error(`[capture-pipeline] auto_review — publishing ${indexed.skill.skill_id} (${indexed.domain}) without explicit review`);
  }
  if (decision.gate === "share_pointers_off") {
    console.error(`[capture-pipeline] private mode — storing ${indexed.skill.skill_id} (${indexed.domain}) privately to your account; submit later to earn`);
  }

  // Stamp the marketplace visibility from the gate so the published manifest is stored
  // public or private accordingly (opt-out → private, submittable later for money).
  indexed.skill.visibility = decision.visibility;
  const publishResult = await publishIndexedSkill(indexed);
  if (!publishResult.published && publishResult.publishStatus === "indexed") {
    console.error(`[capture-pipeline] no remote publish performed for ${indexed.domain}`);
  }
}

export { processIndexJob as _processIndexJobForCli };

/** Check if a domain has an indexing job running. */
/** Check if a domain has an indexing job running. */
export function isIndexingInFlight(domain: string): boolean {
  if (shouldRunInline()) {
    return indexInFlight.has(domain);
  }
  // Disk mode: check pending envelopes + lock file for this domain.
  const queueDir = getQueueDir();
  // P1.1 Day-6 fix: use canonical sanitizeDomain (NFC + Windows-reserved aware).
  // The previous inline regex copy diverged from worker.ts after Day-5 hardening.
  const cap = sanitizeDomain(domain);
  try {
    if (existsSync(join(queueDir, `${cap}.lock`))) return true;
    if (!existsSync(queueDir)) return false;
    for (const name of readdirSync(queueDir)) {
      if (!name.endsWith(".json")) continue;
      if (name.endsWith(".tmp")) continue;
      if (name === `${cap}.json` || name.startsWith(`${cap}.`)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Await all in-flight background index jobs. Call before process exit.
 *
 * Inline mode (test/dev): block until every in-flight job settles.
 *
 * Disk mode (prod): the queue is drained by a detached worker, not this
 * process. We wait briefly for the queue to empty, but if a worker heartbeat
 * is fresh and progress is being made (pending count strictly decreasing),
 * we return success — the detached worker will finish the rest after we
 * exit. The capture's correctness does not depend on indexing finishing
 * within the capture process's lifetime; indexing is intentionally async.
 *
 * Throws only when no worker appears to be running and jobs remain after the
 * timeout — that's a real stuck state.
 */
export async function drainPendingIndexJobs(): Promise<void> {
  if (shouldRunInline()) {
    let logged = false;
    while (indexInFlight.size > 0) {
      const pending = [...indexInFlight.values()];
      if (!logged && process.env.UNBROWSE_TRACE && process.env.UNBROWSE_TRACE !== "0") {
        console.error(`[capture-pipeline] draining ${pending.length} pending job(s)...`);
        logged = true;
      }
      await Promise.allSettled(pending);
    }
    console.error(`[capture-pipeline] all jobs drained`);
    return;
  }

  // Disk mode: detached worker drains the queue. Wait briefly for it to
  // finish, but yield once we see proof of life (fresh heartbeat or
  // strictly-decreasing pending count). The worker keeps going after we exit.
  //
  // Hard cap: UNBROWSE_DRAIN_HARD_MS (default 500ms). The cap keeps CLI exit
  // fast (D5 north-star p50 ≤2s). The detached worker is the authoritative
  // drainer; this poll is courtesy only. UNBROWSE_DRAIN_HARD_MS=30000 in test
  // env restores the old long-wait behavior for drain-worker-alive tests.
  // Each setTimeout in the poll is `.unref()`'d so we never hold the event
  // loop open past the hard cap even if the FS poll is mid-flight.
  const queueDir = getQueueDir();
  const deadDir = join(queueDir, "dead");
  const hardMs = Math.max(
    50,
    Number.parseInt(process.env.UNBROWSE_DRAIN_HARD_MS ?? "200", 10) || 200,
  );
  const timeoutAt = Date.now() + hardMs;
  let lastDeadCount = -1;
  let deadStableSince = Date.now();
  let initialJobCount = -1;
  while (true) {
    const jobs = await listJobs(queueDir);
    let deadCount = 0;
    try {
      if (existsSync(deadDir)) {
        deadCount = readdirSync(deadDir).filter(n => n.endsWith(".json") && !n.endsWith(".tmp")).length;
      }
    } catch {
      deadCount = lastDeadCount < 0 ? 0 : lastDeadCount;
    }
    if (deadCount !== lastDeadCount) {
      lastDeadCount = deadCount;
      deadStableSince = Date.now();
    }
    if (jobs.length === 0 && Date.now() - deadStableSince >= 500) {
      return;
    }
    if (initialJobCount < 0) initialJobCount = jobs.length;
    if (Date.now() >= timeoutAt) {
      // A fresh worker heartbeat (<2s) or strictly-decreasing pending count
      // both prove a detached worker is making progress. Return success and
      // let the worker finish in the background — capture correctness does
      // not depend on indexing finishing within this process's lifetime.
      let workerAlive = false;
      try {
        const hbAge = await heartbeatAgeMs(queueDir);
        if (Number.isFinite(hbAge) && hbAge < 2000) workerAlive = true;
      } catch { /* heartbeat missing — assume no worker */ }
      const makingProgress = initialJobCount > jobs.length;
      if (workerAlive || makingProgress || hardMs <= 5_000) {
        // Short-cap mode (CLI default): always yield once the cap fires;
        // the detached worker owns drain correctness, not this process.
        if (process.env.UNBROWSE_TRACE && process.env.UNBROWSE_TRACE !== "0") {
          console.error(
            `[capture-pipeline] drain cap ${hardMs}ms reached (pending=${jobs.length}, started=${initialJobCount}, dead=${deadCount}); returning — worker continues in background`,
          );
        }
        return;
      }
      throw new Error(`drainPendingIndexJobs: queue not drained after ${hardMs}ms (pending=${jobs.length}, dead=${deadCount})`);
    }
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, 50);
      // Don't pin the event loop on the poll tick — if everything else has
      // released, we want the process to exit even mid-poll.
      if (typeof t.unref === "function") t.unref();
    });
  }
}

export function resetIndexQueueForTests(): void {
  indexInFlight.clear();
  pendingIndexJobs.clear();
  backgroundIndexProcessor = processIndexJob;
}

export function setBackgroundIndexProcessorForTests(processor: BackgroundIndexProcessor | null): void {
  backgroundIndexProcessor = processor ?? processIndexJob;
}
