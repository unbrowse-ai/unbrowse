import { describe, expect, it } from "bun:test";
import {
  computeSavings,
  BROWSER_TOKENS_PER_ACTION,
  BROWSER_MS_PER_ACTION,
  COST_PER_MILLION_TOKENS,
  type SavingsMetrics,
} from "../src/services/savings.js";
import type { PerfStats } from "../src/types.js";

function makePerfStats(overrides: Partial<PerfStats> = {}): PerfStats {
  return {
    total_resolves: 0,
    marketplace_hits: 0,
    cache_hits: 0,
    live_captures: 0,
    dom_fallbacks: 0,
    avg_total_ms: 0,
    avg_search_ms: 0,
    avg_execute_ms: 0,
    avg_marketplace_ms: 0,
    avg_cache_ms: 0,
    avg_live_capture_ms: 0,
    p95_total_ms: 0,
    total_tokens_saved: 0,
    total_response_bytes: 0,
    avg_time_saved_pct: 0,
    avg_tokens_saved_pct: 0,
    last_updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("savings computation", () => {
  it("returns zeroes when there are no resolves", () => {
    const result = computeSavings(makePerfStats());
    expect(result.total_tokens_saved).toBe(0);
    expect(result.actual_cost_usd).toBe(0);
    expect(result.estimated_cost_saved_usd).toBe(0);
    expect(result.estimated_hours_saved).toBe(0);
    expect(result.total_resolves).toBe(0);
    expect(result.estimated_browser_tokens).toBe(0);
    expect(result.estimated_browser_cost_usd).toBe(0);
  });

  it("computes token savings correctly for a known workload", () => {
    // 100 resolves, each saving 11,800 tokens (browser=12000, unbrowse=200)
    const perf = makePerfStats({
      total_resolves: 100,
      total_tokens_saved: 100 * 11_800,
      avg_total_ms: 800,
      avg_time_saved_pct: 98,
      avg_tokens_saved_pct: 98,
    });

    const result = computeSavings(perf);

    // Browser would use 100 * 12000 = 1,200,000 tokens
    expect(result.estimated_browser_tokens).toBe(1_200_000);
    expect(result.total_tokens_saved).toBe(1_180_000);

    // Browser cost: 1.2M tokens * $3/1M = $3.60
    expect(result.estimated_browser_cost_usd).toBe(3.60);

    // Actual tokens: 1,200,000 - 1,180,000 = 20,000
    // Actual cost: 20,000 / 1M * $3 = $0.06
    // Cost saved: $3.60 - $0.06 = $3.54
    expect(result.actual_cost_usd).toBe(0.0006);
    expect(result.estimated_cost_saved_usd).toBe(3.54);

    // Time saved: 100 * (43000 - 800) ms = 4,220,000 ms = 1.172 hours
    const expectedHours = (100 * (43_000 - 800)) / (1000 * 60 * 60);
    expect(result.estimated_hours_saved).toBe(Math.round(expectedHours * 100) / 100);

    expect(result.avg_time_saved_pct).toBe(98);
    expect(result.avg_tokens_saved_pct).toBe(98);
    expect(result.total_resolves).toBe(100);
  });

  it("handles large-scale production-like workload", () => {
    // 10,000 resolves — simulates a production deployment
    const perf = makePerfStats({
      total_resolves: 10_000,
      total_tokens_saved: 10_000 * 11_500,
      avg_total_ms: 1200,
      avg_time_saved_pct: 97,
      avg_tokens_saved_pct: 96,
    });

    const result = computeSavings(perf);

    // Browser would use 10,000 * 12,000 = 120,000,000 tokens
    expect(result.estimated_browser_tokens).toBe(120_000_000);

    // Cost saved should be meaningful
    expect(result.estimated_cost_saved_usd).toBeGreaterThan(300);

    // Time saved should be significant (many hours)
    expect(result.estimated_hours_saved).toBeGreaterThan(100);

    // Sanity: savings should not exceed browser costs
    expect(result.estimated_cost_saved_usd).toBeLessThanOrEqual(result.estimated_browser_cost_usd);
  });

  it("never returns negative savings even with extreme avg_total_ms", () => {
    // Edge case: if Unbrowse was somehow slower than browser automation
    const perf = makePerfStats({
      total_resolves: 10,
      total_tokens_saved: 0,
      avg_total_ms: 100_000, // 100s average — absurdly slow
      avg_time_saved_pct: 0,
      avg_tokens_saved_pct: 0,
    });

    const result = computeSavings(perf);

    // Cost saved could be 0 (no token savings) but hours saved should be 0 too
    expect(result.estimated_cost_saved_usd).toBe(0);
    expect(result.estimated_hours_saved).toBe(0);
  });

  it("uses exported constants consistently", () => {
    // Verify the constants match the cost model documented in speed-comparison
    expect(BROWSER_TOKENS_PER_ACTION).toBe(12_000);
    expect(BROWSER_MS_PER_ACTION).toBe(43_000);
    expect(COST_PER_MILLION_TOKENS).toBe(3.0);
  });

  it("rounds monetary values to two decimal places", () => {
    const perf = makePerfStats({
      total_resolves: 7,
      total_tokens_saved: 7 * 11_800,
      avg_total_ms: 800,
      avg_time_saved_pct: 98,
      avg_tokens_saved_pct: 98,
    });

    const result = computeSavings(perf);

    // Verify rounding: result should have at most 2 decimal places
    const costStr = result.estimated_cost_saved_usd.toString();
    const parts = costStr.split(".");
    if (parts.length === 2) {
      expect(parts[1].length).toBeLessThanOrEqual(2);
    }

    const browserCostStr = result.estimated_browser_cost_usd.toString();
    const browserParts = browserCostStr.split(".");
    if (browserParts.length === 2) {
      expect(browserParts[1].length).toBeLessThanOrEqual(2);
    }
  });
});
