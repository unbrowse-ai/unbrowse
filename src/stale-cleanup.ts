import type { SkillManifest, VerificationStatus } from "./types/index.js";

export type SkillRouteCacheEntryLike = {
  skillId: string;
  domain: string;
  endpointId?: string;
  localSkillPath?: string;
  ts: number;
};

export type DomainSkillCacheEntryLike = {
  skillId: string;
  endpointId?: string;
  localSkillPath?: string;
  ts: number;
};

export type CapturedDomainCacheEntryLike = {
  skill: SkillManifest;
  endpointId?: string;
  expires: number;
};

export type RouteResultCacheEntryLike = {
  skill: SkillManifest;
  endpointId?: string;
  result: unknown;
  trace: unknown;
  expires: number;
};

export type LocalCacheState = {
  capturedDomainCache: Map<string, CapturedDomainCacheEntryLike>;
  skillRouteCache: Map<string, SkillRouteCacheEntryLike>;
  routeResultCache: Map<string, RouteResultCacheEntryLike>;
  domainSkillCache: Map<string, DomainSkillCacheEntryLike>;
};

export type LocalCacheCleanupSummary = {
  route_cache_entries_removed: number;
  domain_cache_entries_removed: number;
  route_result_entries_removed: number;
  captured_domain_entries_removed: number;
};

export function isEndpointStale(
  endpoint: Pick<SkillManifest["endpoints"][number], "verification_status" | "reliability_score"> | undefined,
): boolean {
  if (!endpoint) return true;
  if (endpoint.verification_status === "disabled" || endpoint.verification_status === "failed") return true;
  return typeof endpoint.reliability_score === "number" && endpoint.reliability_score < 0.2;
}

export function countStaleEndpoints(skill: SkillManifest): number {
  return skill.endpoints.filter((endpoint) => isEndpointStale(endpoint)).length;
}

function isSkillEntryStale(
  skill: SkillManifest,
  endpointId?: string,
): boolean {
  if (skill.lifecycle !== "active") return true;
  if (!endpointId) return false;
  return isEndpointStale(skill.endpoints.find((endpoint) => endpoint.endpoint_id === endpointId));
}

export function pruneLocalCacheStateForSkill(
  skill: SkillManifest,
  caches: LocalCacheState,
): LocalCacheCleanupSummary {
  let routeCacheRemoved = 0;
  let domainCacheRemoved = 0;
  let routeResultRemoved = 0;
  let capturedRemoved = 0;

  for (const [key, entry] of caches.skillRouteCache) {
    if (entry.skillId !== skill.skill_id) continue;
    if (!isSkillEntryStale(skill, entry.endpointId)) continue;
    caches.skillRouteCache.delete(key);
    routeCacheRemoved++;
  }

  for (const [key, entry] of caches.domainSkillCache) {
    if (entry.skillId !== skill.skill_id) continue;
    if (!isSkillEntryStale(skill, entry.endpointId)) continue;
    caches.domainSkillCache.delete(key);
    domainCacheRemoved++;
  }

  for (const [key, entry] of caches.routeResultCache) {
    if (entry.skill.skill_id !== skill.skill_id) continue;
    if (!isSkillEntryStale(skill, entry.endpointId)) continue;
    caches.routeResultCache.delete(key);
    routeResultRemoved++;
  }

  for (const [key, entry] of caches.capturedDomainCache) {
    if (entry.skill.skill_id !== skill.skill_id) continue;
    if (!isSkillEntryStale(skill, entry.endpointId)) continue;
    caches.capturedDomainCache.delete(key);
    capturedRemoved++;
  }

  return {
    route_cache_entries_removed: routeCacheRemoved,
    domain_cache_entries_removed: domainCacheRemoved,
    route_result_entries_removed: routeResultRemoved,
    captured_domain_entries_removed: capturedRemoved,
  };
}

export function applyVerificationResults(
  skill: SkillManifest,
  verification: Record<string, VerificationStatus>,
): SkillManifest {
  return {
    ...skill,
    endpoints: skill.endpoints.map((endpoint) => {
      const nextStatus = verification[endpoint.endpoint_id];
      if (!nextStatus) return endpoint;
      const recoveredReliability =
        endpoint.verification_status === "disabled" && nextStatus === "verified"
          ? Math.max(endpoint.reliability_score ?? 0, 0.5)
          : endpoint.reliability_score;
      return {
        ...endpoint,
        verification_status: nextStatus,
        reliability_score: recoveredReliability,
        last_verified_at: new Date().toISOString(),
      };
    }),
  };
}
