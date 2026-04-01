import { buildSkillOperationGraph } from "../graph/index.js";
import { validateManifest, publishSkill, cachePublishedSkill, publishGraphEdges } from "../client/index.js";
import { mergeEndpoints } from "../marketplace/index.js";
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
import type { SkillManifest } from "../types/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";


const SKILL_SNAPSHOT_DIR = join(process.env.HOME ?? "/tmp", ".unbrowse", "skill-snapshots");

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
 * Per-domain dedup: only one job per domain runs at a time.
 */
export function queueBackgroundIndex(job: BackgroundIndexJob): void {
  const key = job.domain;
  if (indexInFlight.has(key)) {
    console.log(`[background-index] skipped for ${key}: already in flight`);
    return;
  }

  const work = processIndexJob(job)
    .catch(err =>
      console.error(`[background-index] failed for ${key}: ${(err as Error).message}`)
    )
    .finally(() => indexInFlight.delete(key));

  indexInFlight.set(key, work);
  console.log(`[background-index] queued for ${key}`);
}

async function processIndexJob(job: BackgroundIndexJob): Promise<void> {
  let { skill, domain, clientScope } = job;
  const scope = clientScope ?? "global";
  const scopedKey = scopedCacheKey(scope, job.cacheKey);

  // 0. Merge with existing domain snapshot (accumulate endpoints across captures)
  const merged = findAndMergeDomainSnapshot(SKILL_SNAPSHOT_DIR, domain, skill);
  if (merged) {
    console.log(`[background-index] merged ${skill.endpoints.length} new endpoint(s) into existing ${merged.endpoints.length - skill.endpoints.length} for ${domain}`);
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

  // 4. Validate + publish to marketplace (remote, ~1.5s total)
  const publishable = skill.endpoints.filter(ep => ep.method !== "WS");
  if (publishable.length === 0) {
    console.log(`[background-index] no publishable endpoints for ${domain}`);
    return;
  }

  const { operation_graph: _g, ...base } = skill;
  const draft: SkillManifest = { ...base, endpoints: publishable };
  const validation = await validateManifest({ ...draft, skill_id: "__validate__" });
  if (!validation.valid) {
    console.warn(
      `[background-index] validation failed for ${domain}: ${validation.hardErrors.join("; ")}`
    );
    return;
  }

  const publishStart = Date.now();
  const published = await publishSkill(draft);
  const publishMs = Date.now() - publishStart;
  console.log(`[background-index] publish latency: ${publishMs}ms for ${domain}`);

  const publishedSkill: SkillManifest = {
    ...published,
    endpoints: skill.endpoints,
    operation_graph: skill.operation_graph,
    ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
  };

  // 5. Update caches with published version (has backend descriptions)
  cachePublishedSkill(publishedSkill, clientScope);
  writeSkillSnapshot(scopedKey, publishedSkill);

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

  console.log(`[background-index] completed for ${domain} -> ${published.skill_id}`);
}

/** Check if a domain has an indexing job running. */
export function isIndexingInFlight(domain: string): boolean {
  return indexInFlight.has(domain);
}

/** Await all in-flight background index jobs. Call before process exit. */
export async function drainPendingIndexJobs(): Promise<void> {
  const pending = [...indexInFlight.values()];
  if (pending.length === 0) return;
  console.log(`[background-index] draining ${pending.length} pending job(s)...`);
  await Promise.allSettled(pending);
  console.log(`[background-index] all jobs drained`);
}

export function resetIndexQueueForTests(): void {
  indexInFlight.clear();
}
