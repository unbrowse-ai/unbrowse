import { listSkills } from "./marketplace/index.js";
import { verifySkill } from "./verification/index.js";
import { selectVerificationCandidates } from "./verification/candidates.js";
import type { SkillManifest } from "./types/index.js";
import {
  applyVerificationResults,
  countStaleEndpoints,
  type LocalCacheCleanupSummary,
} from "./stale-cleanup.js";
import { pruneLocalCacheEntriesForSkill } from "./orchestrator/index.js";

const VERIFY_TIMEOUT_MS = Math.max(5_000, Number(process.env.UNBROWSE_STALE_VERIFY_TIMEOUT_MS ?? 15_000));
const CLEANUP_INTERVAL_MS = Math.max(30 * 60 * 1000, Number(process.env.UNBROWSE_STALE_CLEANUP_INTERVAL_MS ?? 6 * 60 * 60 * 1000));
const CLEANUP_BATCH_SIZE = Math.max(1, Number(process.env.UNBROWSE_STALE_CLEANUP_BATCH_SIZE ?? 25));
const CLEANUP_VERIFY_ENDPOINT_LIMIT = Math.max(1, Number(process.env.UNBROWSE_STALE_VERIFY_ENDPOINT_LIMIT ?? 2));

export type SkillCleanupSummary = {
  skill_id: string;
  domain: string;
  lifecycle: SkillManifest["lifecycle"];
  verified: boolean;
  stale_before: number;
  stale_after: number;
  cache_cleanup: LocalCacheCleanupSummary;
  error?: string;
};

export async function cleanupStaleSkills(options?: {
  skill_id?: string;
  domain?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  ok: true;
  scanned_skills: number;
  verified_skills: number;
  stale_before: number;
  stale_after: number;
  cache_cleanup: LocalCacheCleanupSummary;
  skills: SkillCleanupSummary[];
}> {
  const normalizedDomain = options?.domain?.trim().toLowerCase();
  let skills = await listSkills();
  if (options?.skill_id) skills = skills.filter((skill) => skill.skill_id === options.skill_id);
  if (normalizedDomain) {
    skills = skills.filter((skill) => {
      const domain = skill.domain.trim().toLowerCase();
      return domain === normalizedDomain || domain.replace(/^www\./, "") === normalizedDomain.replace(/^www\./, "");
    });
  }
  if (options?.offset && Number.isFinite(options.offset) && options.offset > 0) {
    skills = skills.slice(options.offset);
  }
  if (options?.limit && Number.isFinite(options.limit) && options.limit > 0) {
    skills = skills.slice(0, options.limit);
  }

  const perSkill: SkillCleanupSummary[] = [];
  const cacheTotals: LocalCacheCleanupSummary = {
    route_cache_entries_removed: 0,
    domain_cache_entries_removed: 0,
    route_result_entries_removed: 0,
    captured_domain_entries_removed: 0,
  };
  let staleBefore = 0;
  let staleAfter = 0;
  let verifiedSkills = 0;

  for (const skill of skills) {
    const before = countStaleEndpoints(skill);
    staleBefore += before;
    let refreshed = skill;
    let verified = false;
    let error: string | undefined;

    if (skill.lifecycle === "active" && skill.endpoints.some((endpoint) => endpoint.method === "GET")) {
      try {
        const endpoints = selectVerificationCandidates(skill, {
          staleOnly: true,
          limit: CLEANUP_VERIFY_ENDPOINT_LIMIT,
        });
        const verification = await Promise.race([
          verifySkill(skill, { endpoints }),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error(`verification timed out after ${VERIFY_TIMEOUT_MS}ms`)), VERIFY_TIMEOUT_MS);
          }),
        ]);
        refreshed = applyVerificationResults(skill, verification);
        verified = true;
        verifiedSkills++;
      } catch (err) {
        error = (err as Error).message;
      }
    }

    const cacheCleanup = pruneLocalCacheEntriesForSkill(refreshed);
    cacheTotals.route_cache_entries_removed += cacheCleanup.route_cache_entries_removed;
    cacheTotals.domain_cache_entries_removed += cacheCleanup.domain_cache_entries_removed;
    cacheTotals.route_result_entries_removed += cacheCleanup.route_result_entries_removed;
    cacheTotals.captured_domain_entries_removed += cacheCleanup.captured_domain_entries_removed;

    const after = countStaleEndpoints(refreshed);
    staleAfter += after;
    perSkill.push({
      skill_id: refreshed.skill_id,
      domain: refreshed.domain,
      lifecycle: refreshed.lifecycle,
      verified,
      stale_before: before,
      stale_after: after,
      cache_cleanup: cacheCleanup,
      ...(error ? { error } : {}),
    });
  }

  return {
    ok: true,
    scanned_skills: skills.length,
    verified_skills: verifiedSkills,
    stale_before: staleBefore,
    stale_after: staleAfter,
    cache_cleanup: cacheTotals,
    skills: perSkill,
  };
}

export function schedulePeriodicStaleCleanup(): ReturnType<typeof setInterval> {
  let offset = 0;
  return setInterval(async () => {
    try {
      const result = await cleanupStaleSkills({
        limit: CLEANUP_BATCH_SIZE,
        offset,
      });
      if (result.scanned_skills < CLEANUP_BATCH_SIZE) offset = 0;
      else offset += result.scanned_skills;
      console.log(
        `[stale-cleanup] scanned=${result.scanned_skills} verified=${result.verified_skills} stale=${result.stale_before}->${result.stale_after} removed=${result.cache_cleanup.route_cache_entries_removed + result.cache_cleanup.domain_cache_entries_removed + result.cache_cleanup.route_result_entries_removed + result.cache_cleanup.captured_domain_entries_removed}`,
      );
    } catch (err) {
      console.warn(`[stale-cleanup] sweep failed: ${(err as Error).message}`);
    }
  }, CLEANUP_INTERVAL_MS);
}
