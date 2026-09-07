/**
 * Savings computation — derives cost and time savings metrics from PerfStats.
 *
 * Cost model assumptions (conservative, based on public pricing):
 *   - Browser automation (Computer Use): ~12,000 tokens per action, ~43s per action
 *   - Unbrowse direct API execution: ~200 tokens per action, ~0.8s per action
 *   - Token cost: $3 per 1M input tokens (Claude 3.5 Sonnet pricing)
 *
 * These constants are exported for testability and can be tuned over time.
 */

import type { PerfStats } from "../types.js";

// ─── Cost model constants ───

/** Estimated tokens per browser automation action (screenshot + vision + click) */
export const BROWSER_TOKENS_PER_ACTION = 12_000;

/** Estimated time per browser automation action in milliseconds */
export const BROWSER_MS_PER_ACTION = 43_000;

/** Cost per 1M tokens in USD (Claude 3.5 Sonnet input pricing) */
export const COST_PER_MILLION_TOKENS = 3.0;

// ─── Types ───

export interface SavingsMetrics {
  /** Total tokens saved across all resolves */
  total_tokens_saved: number;
  /** Estimated actual Unbrowse spend per action */
  actual_cost_usd: number;
  /** Estimated USD saved from token reduction */
  estimated_cost_saved_usd: number;
  /** Estimated total hours saved vs browser automation */
  estimated_hours_saved: number;
  /** Average time savings percentage per resolve */
  avg_time_saved_pct: number;
  /** Average token savings percentage per resolve */
  avg_tokens_saved_pct: number;
  /** Total number of resolves contributing to savings */
  total_resolves: number;
  /** Estimated tokens that browser automation would have used */
  estimated_browser_tokens: number;
  /** Estimated cost if using browser automation */
  estimated_browser_cost_usd: number;
}

// ─── Computation ───

export function computeSavings(perf: PerfStats): SavingsMetrics {
  const totalResolves = perf.total_resolves;

  // Estimate what browser automation would have consumed
  const estimatedBrowserTokens = totalResolves * BROWSER_TOKENS_PER_ACTION;
  const estimatedBrowserCostUsd =
    (estimatedBrowserTokens / 1_000_000) * COST_PER_MILLION_TOKENS;

  // Actual tokens used = browser tokens - tokens saved
  const actualTokensUsed = Math.max(0, estimatedBrowserTokens - perf.total_tokens_saved);
  const actualCostUsd = (actualTokensUsed / 1_000_000) * COST_PER_MILLION_TOKENS;
  const estimatedCostSavedUsd = estimatedBrowserCostUsd - actualCostUsd;

  // Time savings: each resolve saves (browser_ms - actual_ms)
  // actual_ms = avg_total_ms per resolve
  const browserTotalMs = totalResolves * BROWSER_MS_PER_ACTION;
  const actualTotalMs = totalResolves * perf.avg_total_ms;
  const savedMs = Math.max(0, browserTotalMs - actualTotalMs);
  const estimatedHoursSaved = savedMs / (1000 * 60 * 60);

  return {
    total_tokens_saved: perf.total_tokens_saved,
    actual_cost_usd: totalResolves > 0 ? Math.round((actualCostUsd / totalResolves) * 10_000) / 10_000 : 0,
    estimated_cost_saved_usd: Math.round(estimatedCostSavedUsd * 100) / 100,
    estimated_hours_saved: Math.round(estimatedHoursSaved * 100) / 100,
    avg_time_saved_pct: Math.round(perf.avg_time_saved_pct),
    avg_tokens_saved_pct: Math.round(perf.avg_tokens_saved_pct),
    total_resolves: totalResolves,
    estimated_browser_tokens: estimatedBrowserTokens,
    estimated_browser_cost_usd: Math.round(estimatedBrowserCostUsd * 100) / 100,
  };
}
