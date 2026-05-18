/**
 * Dynamic route pricing and site-owner compensation — issue #40
 *
 * Computes a per-execution price for a skill based on:
 *   1. Base price (platform default or skill override)
 *   2. Demand multiplier — logarithmic growth with usage volume
 *   3. Reliability multiplier — higher-reliability routes cost more
 *
 * Formula:
 *   demand_mult   = 1 + min(log10(1 + total_executions) / 3, 1.0)
 *   reliability_m = 0.5 + 0.5 × reliability_score          ← never below 50%
 *   price_usd     = base_price × demand_mult × reliability_m
 *   price_usd     = clamp(price_usd, MIN_PRICE_USD, MAX_PRICE_USD)
 *
 * Site-owner compensation share:
 *   When owner_compensation_opt_in=true, SITE_OWNER_SHARE_PCT of the price
 *   is earmarked for the site owner.  The remainder goes to the platform +
 *   indexer attribution (Tier 1).
 */

import type { SkillManifest, EndpointStats } from "../types.js";

// ─── Price parameters ─────────────────────────────────────────────────────────

/** Default base price per execution if the skill doesn't override it (USD). */
export const DEFAULT_BASE_PRICE_USD = 0.001; // $0.001 = 0.1 cents

/** Hard floor — no route costs less than this regardless of reliability (USD). */
export const MIN_PRICE_USD = 0.0001; // $0.0001

/** Hard ceiling — prevents runaway prices on viral high-demand routes (USD). */
export const MAX_PRICE_USD = 0.10; // $0.10

/**
 * Fraction of the execution price earmarked for the site owner when
 * owner_compensation_opt_in is true. Mirrors `OWNER_BPS = 1500` in
 * `services/flex.ts` (1500/10000 = 0.15).
 */
export const SITE_OWNER_SHARE_PCT = 0.15; // 15%

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RoutePriceResult {
  skill_id: string;
  /** Computed execution price in USD. */
  price_usd: number;
  /** Formatted as a dollar string for display. */
  price_display: string;
  /** Breakdown of multipliers. */
  breakdown: {
    base_price_usd: number;
    demand_multiplier: number;
    reliability_multiplier: number;
  };
  /** Whether the site owner opted in to compensation. */
  owner_compensation_opt_in: boolean;
  /** USD amount earmarked for site owner per execution (0 if not opted in). */
  site_owner_share_usd: number;
  /** Average reliability score across all endpoints (0–1). */
  avg_reliability_score: number;
  /** Total executions across all endpoints. */
  total_executions: number;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

/**
 * Compute the demand multiplier given total execution count.
 * Ranges from 1.0 (no usage) to 2.0 (very high usage).
 * Pure function — no I/O.
 */
export function computeDemandMultiplier(totalExecutions: number): number {
  return 1 + Math.min(Math.log10(1 + totalExecutions) / 3, 1.0);
}

/**
 * Compute the reliability multiplier given an average reliability score [0, 1].
 * Ranges from 0.50 (worst reliability) to 1.00 (perfect reliability).
 * Pure function — no I/O.
 */
export function computeReliabilityMultiplier(avgReliabilityScore: number): number {
  return 0.5 + 0.5 * Math.max(0, Math.min(1, avgReliabilityScore));
}

/**
 * Compute the full dynamic route price for a skill.
 * Pure function — accepts manifest + per-endpoint stats, returns price breakdown.
 */
export function computeRoutePrice(
  manifest: Pick<SkillManifest, "skill_id" | "owner_compensation_opt_in" | "base_price_usd" | "endpoints">,
  endpointStats: EndpointStats[],
): RoutePriceResult {
  const base = manifest.base_price_usd ?? DEFAULT_BASE_PRICE_USD;

  // Aggregate stats across all endpoints
  const totalExecutions = endpointStats.reduce((s, e) => s + e.total_executions, 0);
  const avgReliability = endpointStats.length > 0
    ? endpointStats.reduce((s, e) => s + e.successful_executions / Math.max(1, e.total_executions), 0) / endpointStats.length
    : 0.5;

  const demandMultiplier      = computeDemandMultiplier(totalExecutions);
  const reliabilityMultiplier = computeReliabilityMultiplier(avgReliability);

  const rawPrice = base * demandMultiplier * reliabilityMultiplier;
  const price_usd = Math.max(MIN_PRICE_USD, Math.min(MAX_PRICE_USD, rawPrice));

  const optIn = manifest.owner_compensation_opt_in ?? false;
  const site_owner_share_usd = optIn ? price_usd * SITE_OWNER_SHARE_PCT : 0;

  return {
    skill_id: manifest.skill_id,
    price_usd,
    price_display: `$${price_usd.toFixed(6)}`,
    breakdown: {
      base_price_usd: base,
      demand_multiplier: demandMultiplier,
      reliability_multiplier: reliabilityMultiplier,
    },
    owner_compensation_opt_in: optIn,
    site_owner_share_usd,
    avg_reliability_score: avgReliability,
    total_executions: totalExecutions,
  };
}
