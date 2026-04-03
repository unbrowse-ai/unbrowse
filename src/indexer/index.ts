import { buildSkillOperationGraph } from "../graph/index.js";
import { validateManifest, publishSkill, cachePublishedSkill, publishGraphEdges } from "../client/index.js";
import { mergeEndpoints } from "../marketplace/index.js";
import {
  selectMarketplacePublishEndpoints,
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
import type { SkillManifest, EndpointDescriptor } from "../types/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sanitizeForPublish } from "../publish/sanitize.js";
import { readWorkflowArtifact } from "../workflow/artifact.js";
import { buildWorkflowPublishArtifact, writeWorkflowPublishArtifact } from "../workflow/publish.js";

const UNBROWSE_CONFIG_PATH = join(homedir(), ".unbrowse", "config.json");
const SKILL_SNAPSHOT_DIR = process.env.UNBROWSE_SKILL_SNAPSHOT_DIR
  ?? join(process.env.HOME ?? "/tmp", ".unbrowse", "skill-snapshots");

/** Read agent_id from local config — used for contributor attribution on publish. */
function getLocalAgentId(): string | undefined {
  try {
    const config = JSON.parse(readFileSync(UNBROWSE_CONFIG_PATH, "utf-8"));
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
  reviews: Array<{
    endpoint_id: string;
    description?: string;
    action_kind?: string;
    resource_kind?: string;
    example_request?: unknown;
    example_response?: unknown;
  }>,
): EndpointDescriptor[] {
  const reviewMap = new Map(reviews.map((r) => [r.endpoint_id, r]));
  return endpoints.map((ep) => {
    const reviewed = reviewMap.get(ep.endpoint_id);
    if (!reviewed) return ep;
    return {
      ...ep,
      description: reviewed.description || ep.description,
      semantic: ep.semantic ? {
        ...ep.semantic,
        action_kind: reviewed.action_kind || ep.semantic.action_kind,
        resource_kind: reviewed.resource_kind || ep.semantic.resource_kind,
        description_out: reviewed.description || ep.semantic.description_out,
        ...(reviewed.example_response ? { example_response_compact: reviewed.example_response } : {}),
        ...(reviewed.example_request ? { example_request: reviewed.example_request } : {}),
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
}

/**
 * Queue a skill for background processing: graph building, marketplace
 * validation, and publishing. Non-blocking — returns immediately.
 * Per-domain coalescing: only one job per domain runs at a time, while the
 * latest pending work for that domain is merged and replayed after the active
 * job completes.
 */
export function queueBackgroundIndex(job: BackgroundIndexJob): void {
  const key = job.domain;
  if (indexInFlight.has(key)) {
    const pending = pendingIndexJobs.get(key);
    pendingIndexJobs.set(key, pending ? mergeBackgroundIndexJobs(pending, job) : job);
    console.error(`[background-index] coalesced pending job for ${key}: already in flight`);
    return;
  }

  const work = backgroundIndexProcessor(job)
    .catch(err =>
      console.error(`[background-index] failed for ${key}: ${(err as Error).message}`)
    )
    .finally(() => {
      indexInFlight.delete(key);
      const pending = pendingIndexJobs.get(key);
      if (pending) {
        pendingIndexJobs.delete(key);
        console.error(`[background-index] replaying coalesced job for ${key}`);
        queueBackgroundIndex(pending);
      }
    });

  indexInFlight.set(key, work);
  console.error(`[background-index] queued for ${key}`);
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
  };
}

async function processIndexJob(job: BackgroundIndexJob): Promise<void> {
  let { skill, domain, clientScope } = job;
  const scope = clientScope ?? "global";
  const scopedKey = scopedCacheKey(scope, job.cacheKey);

  // 0. Merge with existing domain snapshot (accumulate endpoints across captures)
  const merged = findAndMergeDomainSnapshot(SKILL_SNAPSHOT_DIR, domain, skill);
  if (merged) {
    console.error(`[background-index] merged ${skill.endpoints.length} new endpoint(s) into existing ${merged.endpoints.length - skill.endpoints.length} for ${domain}`);
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

  // 3. Update local snapshot with merged skill + graph + descriptions

  // 4. Sanitize + validate + publish to marketplace (remote, ~1.5s total)
  const selection = selectMarketplacePublishEndpoints(skill);
  if (selection.endpoints.length === 0) {
    console.error(
      `[background-index] no publishable endpoints for ${domain} (${formatMarketplacePublishSelection(selection)})`,
    );
    return;
  }
  console.error(
    `[background-index] publishing ${selection.endpoints.length}/${selection.stats.total} endpoint(s) for ${domain} (${formatMarketplacePublishSelection(selection)})`,
  );

  // Deterministic PII sanitization — secrets redacted, values replaced with synthetic placeholders.
  // The calling agent can later POST to /v1/skills/:id/review with better descriptions and examples.
  const sanitized = sanitizeForPublish(selection.endpoints);

  const { operation_graph: _g, ...base } = skill;
  const draft: SkillManifest = { ...base, endpoints: sanitized, indexer_id: getLocalAgentId() };
  const validation = await validateManifest({ ...draft, skill_id: "__validate__" });
  if (!validation.valid) {
    writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(
      skill,
      readWorkflowArtifact(skill.skill_id),
      {
        publishStatus: "blocked-validation",
        validationErrors: validation.hardErrors,
      },
    ));
    console.warn(
      `[background-index] validation failed for ${domain}: ${validation.hardErrors.join("; ")}`
    );
    return;
  }

  const publishStart = Date.now();
  const published = await publishSkill(draft);
  const publishMs = Date.now() - publishStart;
  console.error(`[background-index] publish latency: ${publishMs}ms for ${domain}`);

  const publishedSkill: SkillManifest = {
    ...published,
    endpoints: skill.endpoints,
    operation_graph: skill.operation_graph,
    ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
  };

  // 5. Update caches with published version (has backend descriptions)
  cachePublishedSkill(publishedSkill, clientScope);
  writeSkillSnapshot(scopedKey, publishedSkill);
  writeWorkflowPublishArtifact(buildWorkflowPublishArtifact(
    skill,
    readWorkflowArtifact(skill.skill_id),
    {
      publishStatus: "published",
      publishedAt: new Date().toISOString(),
    },
  ));

  // 6. Publish graph edges via dedicated endpoint (fire-and-forget)
  if (skill.operation_graph?.operations) {
    for (const op of skill.operation_graph.operations) {
      const opEdges = (skill.operation_graph.edges ?? [])
        .filter(e => e.from_operation_id === op.operation_id)
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

  // 7. Update domain cache so cross-intent reuse works
  const domainKey = getDomainReuseKey(job.contextUrl ?? domain);
  if (domainKey) {
    domainSkillCache.set(domainKey, {
      skillId: publishedSkill.skill_id,
      localSkillPath: snapshotPathForCacheKey(scopedKey),
      ts: Date.now(),
    });
    persistDomainCache();
  }

  console.error(`[background-index] completed for ${domain} -> ${published.skill_id}`);
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
      console.error(`[background-index] draining ${pending.length} pending job(s)...`);
      logged = true;
    }
    await Promise.allSettled(pending);
  }
  console.error(`[background-index] all jobs drained`);
}

export function resetIndexQueueForTests(): void {
  indexInFlight.clear();
  pendingIndexJobs.clear();
  backgroundIndexProcessor = processIndexJob;
}

export function setBackgroundIndexProcessorForTests(processor: BackgroundIndexProcessor | null): void {
  backgroundIndexProcessor = processor ?? processIndexJob;
}
