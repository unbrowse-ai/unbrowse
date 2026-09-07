import type { Env } from "../types.js";

export interface FreshnessProbeResult {
  probed: number;
  fresh: number;
  stale_suspect: number;
  stale_confirmed: number;
}

/**
 * Plan-v15 Tier 2 SEED: cron-triggered probe of N=20 popular skills.
 * STUB: returns zero counts today. Step 6 (Dominion) wires the actual
 * libcurl-impersonate fetch + sidecar KV write per skill.
 */
export async function probeFreshness(env: Env): Promise<FreshnessProbeResult> {
  // TODO(plan-v15 Step 6): pick N=20 popular skills via listPopularSkills,
  // fetch each via libcurl-impersonate, classify response, write sidecar
  // KV key skill:<id>:freshness with {state, last_probed_at, consecutive_failures, last_status}.
  void env;
  return { probed: 0, fresh: 0, stale_suspect: 0, stale_confirmed: 0 };
}

export type FreshnessState = "fresh" | "stale_suspect" | "stale_confirmed";

export interface FreshnessRecord {
  state: FreshnessState;
  last_probed_at: number;
  consecutive_failures: number;
  last_status: number;
}

export const FRESHNESS_KV_PREFIX = "skill:";
export const FRESHNESS_KV_SUFFIX = ":freshness";
