import { buildSkillOperationGraph } from "../graph/index.js";
import { validateManifest, publishSkill, cachePublishedSkill, publishGraphEdges } from "../client/index.js";
import { mergeEndpoints } from "../marketplace/index.js";
import {
  selectMarketplacePublishClosure,
  formatMarketplacePublishSelection,
} from "../publish-admission.js";
import {
  writeSkillSnapshot,
  domainSkillCache,
  persistDomainCache,
  getDomainReuseKey,
  scopedCacheKey,
  snapshotPathForCacheKey,
  generateLocalDescription,
} from "../orchestrator/index.js";
import { getRegistrableDomain } from "../domain.js";
import type { EndpointReviewPayload, SkillManifest, EndpointDescriptor } from "../types/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeForPublish } from "../publish/sanitize.js";
import { readWorkflowArtifact } from "../workflow/artifact.js";
import { buildWorkflowPublishArtifact, writeWorkflowPublishArtifact } from "../workflow/publish.js";
import { getUnbrowseConfigPath } from "../settings.js";
import { getEndpointDescriptionMetadata } from "../graph/index.js";
import { applyBindingReviews, applyResponseSchemaReviews } from "../publish/schema-review.js";
import { getContributionConfig } from "../config/contribution.js";

const SKILL_SNAPSHOT_DIR = process.env.UNBROWSE_SKILL_SNAPSHOT_DIR
  ?? join(process.env.HOME ?? "/tmp", ".unbrowse", "skill-snapshots");

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

async function processIndexJob(job: BackgroundIndexJob): Promise<void> {
  const indexed = await indexSkillLocally(job);
  console.error(`[capture-pipeline] local index completed for ${indexed.domain} -> ${indexed.skill.skill_id}`);

  if (!job.publishAfterIndex) {
    console.error(`[capture-pipeline] remote publish not queued for ${indexed.domain}`);
    return;
  }

  // Phase 8.2 — gate marketplace publish on the user's contribution mode.
  // When share_pointers=false (default), the local index/cache write above
  // still happened — only the remote publish is skipped. This is a
  // privacy-preserving default; users opt into sharing via `unbrowse setup`
  // or `unbrowse mode`.
  const { contribution } = getContributionConfig();
  if (!contribution.share_pointers) {
    console.error(
      `[capture-pipeline] share_pointers=false — skipping marketplace publish for skill ${indexed.skill.skill_id} (${indexed.domain}). Run \`unbrowse mode\` to opt into sharing.`,
    );
    return;
  }

  const publishResult = await publishIndexedSkill(indexed);
  if (!publishResult.published && publishResult.publishStatus === "indexed") {
    console.error(`[capture-pipeline] no remote publish performed for ${indexed.domain}`);
  }
}

/** Check if a domain has an indexing job running. */
export function isIndexingInFlight(domain: string): boolean {
  return indexInFlight.has(domain);
}

/** Await all in-flight background index jobs. Call before process exit. */
export async function drainPendingIndexJobs(): Promise<void> {
  let logged = false;
  while (indexInFlight.size > 0) {
    const pending = [...indexInFlight.values()];
    if (!logged) {
      console.error(`[capture-pipeline] draining ${pending.length} pending job(s)...`);
      logged = true;
    }
    await Promise.allSettled(pending);
  }
  console.error(`[capture-pipeline] all jobs drained`);
}

export function resetIndexQueueForTests(): void {
  indexInFlight.clear();
  pendingIndexJobs.clear();
  backgroundIndexProcessor = processIndexJob;
}

export function setBackgroundIndexProcessorForTests(processor: BackgroundIndexProcessor | null): void {
  backgroundIndexProcessor = processor ?? processIndexJob;
}
