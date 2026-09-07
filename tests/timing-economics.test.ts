import { describe, expect, it } from "bun:test";
import {
  DEFAULT_CAPTURE_MS,
  DEFAULT_CAPTURE_TOKENS,
  TOKEN_COST_UC,
  computeTimingEconomics,
} from "../src/orchestrator/timing-economics.js";

describe("computeTimingEconomics", () => {
  it("derives real baseline speed and cost savings for cached runs", () => {
    const economics = computeTimingEconomics({
      source: "marketplace",
      totalMs: 950,
      result: { rows: Array.from({ length: 10 }, (_, id) => ({ id, label: "x".repeat(20) })) },
      skill: {
        discovery_cost: {
          capture_ms: 12_400,
          capture_tokens: 18_500,
          response_bytes: 4096,
          captured_at: "2026-04-03T00:00:00.000Z",
        },
      },
      paidSearchUc: 1_000,
      paidExecutionUc: 5_000,
    });

    expect(economics.baseline_source).toBe("real");
    expect(economics.baseline_total_ms).toBe(12_400);
    expect(economics.time_saved_ms).toBe(11_450);
    expect(economics.time_saved_pct).toBe(92);
    expect(economics.baseline_cost_uc).toBe(18_500 * TOKEN_COST_UC);
    expect(economics.actual_cost_uc).toBeGreaterThan(6_000);
    expect(economics.cost_saved_uc).toBe(
      (18_500 * TOKEN_COST_UC) - economics.actual_cost_uc,
    );
    expect(economics.tokens_saved).toBeGreaterThan(0);
    expect(economics.tokens_saved_pct).toBeGreaterThan(0);
  });

  it("falls back to estimated browser baselines when discovery cost is missing", () => {
    const economics = computeTimingEconomics({
      source: "route-cache",
      totalMs: 1_200,
      result: "x".repeat(800),
    });

    expect(economics.baseline_source).toBe("estimated");
    expect(economics.baseline_total_ms).toBe(DEFAULT_CAPTURE_MS);
    expect(economics.time_saved_ms).toBe(DEFAULT_CAPTURE_MS - 1_200);
    expect(economics.baseline_cost_uc).toBe(DEFAULT_CAPTURE_TOKENS * TOKEN_COST_UC);
    expect(economics.actual_cost_uc).toBe(200 * TOKEN_COST_UC);
    expect(economics.cost_saved_uc).toBe(
      (DEFAULT_CAPTURE_TOKENS * TOKEN_COST_UC) - (200 * TOKEN_COST_UC),
    );
    expect(economics.tokens_saved).toBe(DEFAULT_CAPTURE_TOKENS - 200);
    expect(economics.tokens_saved_pct).toBe(99);
  });

  it("counts direct document responses as browser-avoiding savings", () => {
    const economics = computeTimingEconomics({
      source: "direct-document",
      totalMs: 700,
      result: { title: "Markets - Bloomberg", text_excerpt: "x".repeat(1_200) },
    });

    expect(economics.baseline_source).toBe("estimated");
    expect(economics.baseline_total_ms).toBe(DEFAULT_CAPTURE_MS);
    expect(economics.time_saved_ms).toBe(DEFAULT_CAPTURE_MS - 700);
    expect(economics.tokens_saved).toBeGreaterThan(0);
    expect(economics.time_saved_pct).toBeGreaterThan(0);
  });

  it("does not report savings for live capture paths", () => {
    const economics = computeTimingEconomics({
      source: "live-capture",
      totalMs: 8_000,
      result: { ok: true },
    });

    expect(economics.baseline_source).toBeUndefined();
    expect(economics.baseline_total_ms).toBeUndefined();
    expect(economics.time_saved_ms).toBeUndefined();
    expect(economics.baseline_cost_uc).toBeUndefined();
    expect(economics.cost_saved_uc).toBeUndefined();
    expect(economics.tokens_saved).toBe(0);
    expect(economics.time_saved_pct).toBe(0);
    expect(economics.actual_cost_uc).toBeGreaterThan(0);
  });
});
