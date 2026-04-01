import { buildSkillOperationGraph } from "../graph/index.js";
import { validateManifest, publishSkill, cachePublishedSkill } from "../client/index.js";
import {
  writeSkillSnapshot,
  domainSkillCache,
  persistDomainCache,
  getDomainReuseKey,
  scopedCacheKey,
  snapshotPathForCacheKey,
  generateLocalDescription,
} from "../orchestrator/index.js";
import type { SkillManifest } from "../types/index.js";

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
  const { skill, domain, clientScope } = job;
  const scope = clientScope ?? "global";
  const scopedKey = scopedCacheKey(scope, job.cacheKey);

  // 1. Build operation graph (CPU, ~20ms)
  skill.operation_graph = buildSkillOperationGraph(skill.endpoints);

  // 2. Generate local descriptions for BM25 ranking
  for (const ep of skill.endpoints) {
    if (!ep.description) {
      ep.description = generateLocalDescription(ep);
    }
  }

  // 3. Update local snapshot with graph + descriptions
  writeSkillSnapshot(scopedKey, skill);

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

  const published = await publishSkill(draft);
  const merged: SkillManifest = {
    ...published,
    endpoints: skill.endpoints,
    operation_graph: skill.operation_graph,
    ...(skill.auth_profile_ref ? { auth_profile_ref: skill.auth_profile_ref } : {}),
  };

  // 5. Update caches with published version (has backend descriptions)
  cachePublishedSkill(merged, clientScope);
  writeSkillSnapshot(scopedKey, merged);

  // 6. Update domain cache so cross-intent reuse works
  const domainKey = getDomainReuseKey(job.contextUrl ?? domain);
  if (domainKey) {
    domainSkillCache.set(domainKey, {
      skillId: merged.skill_id,
      localSkillPath: snapshotPathForCacheKey(scopedKey),
      ts: Date.now(),
    });
    persistDomainCache();
  }

  console.log(`[background-index] completed for ${domain} → ${published.skill_id}`);
}

/** Check if a domain has an indexing job running. */
export function isIndexingInFlight(domain: string): boolean {
  return indexInFlight.has(domain);
}

/** Reset for tests. */
export function resetIndexQueueForTests(): void {
  indexInFlight.clear();
}
