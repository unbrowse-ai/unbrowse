/**
 * Dynamic route pricing tests — issue #40
 *
 * Tests the pure pricing logic without hitting KV or the network.
 *
 * Run:
 *   bun test backend/tests/pricing.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  computeDemandMultiplier,
  computeReliabilityMultiplier,
  computeRoutePrice,
  DEFAULT_BASE_PRICE_USD,
  MIN_PRICE_USD,
  MAX_PRICE_USD,
  SITE_OWNER_SHARE_PCT,
} from "../src/services/pricing.js";
import type { EndpointStats } from "../src/types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeStats(total: number, successes: number): EndpointStats {
  return {
    total_executions: total,
    successful_executions: successes,
    consecutive_failures: 0,
    avg_latency_ms: 100,
    feedback_sum: 0,
    feedback_count: 0,
    drift_count: 0,
  };
}

const VERIFIED_ENDPOINT = {
  endpoint_id: "ep-1",
  method: "GET" as const,
  url_template: "https://example.com/api",
  idempotency: "safe" as const,
  verification_status: "verified" as const,
  reliability_score: 0.9,
};

// ─── Demand multiplier tests ──────────────────────────────────────────────────

describe("computeDemandMultiplier", () => {
  it("returns 1.0 for a brand-new route (0 executions)", () => {
    expect(computeDemandMultiplier(0)).toBe(1.0);
  });

  it("increases monotonically with executions", () => {
    const m0   = computeDemandMultiplier(0);
    const m10  = computeDemandMultiplier(10);
    const m100 = computeDemandMultiplier(100);
    const m10k = computeDemandMultiplier(10_000);
    expect(m10).toBeGreaterThan(m0);
    expect(m100).toBeGreaterThan(m10);
    expect(m10k).toBeGreaterThan(m100);
  });

  it("is capped at 2.0 (logarithmic ceiling)", () => {
    expect(computeDemandMultiplier(1_000_000)).toBeLessThanOrEqual(2.0);
    expect(computeDemandMultiplier(Number.MAX_SAFE_INTEGER)).toBeLessThanOrEqual(2.0);
  });

  it("is always >= 1.0", () => {
    for (const n of [0, 1, 10, 100, 1000]) {
      expect(computeDemandMultiplier(n)).toBeGreaterThanOrEqual(1.0);
    }
  });
});

// ─── Reliability multiplier tests ─────────────────────────────────────────────

describe("computeReliabilityMultiplier", () => {
  it("returns 0.5 for a completely unreliable route (score=0)", () => {
    expect(computeReliabilityMultiplier(0)).toBe(0.5);
  });

  it("returns 1.0 for a perfectly reliable route (score=1)", () => {
    expect(computeReliabilityMultiplier(1)).toBe(1.0);
  });

  it("returns 0.75 for a 50% reliable route", () => {
    expect(computeReliabilityMultiplier(0.5)).toBe(0.75);
  });

  it("is monotonically increasing with reliability", () => {
    expect(computeReliabilityMultiplier(0.8)).toBeGreaterThan(computeReliabilityMultiplier(0.5));
    expect(computeReliabilityMultiplier(0.5)).toBeGreaterThan(computeReliabilityMultiplier(0.2));
  });

  it("clamps out-of-range inputs to [0.5, 1.0]", () => {
    expect(computeReliabilityMultiplier(-1)).toBe(0.5);
    expect(computeReliabilityMultiplier(2)).toBe(1.0);
  });
});

// ─── computeRoutePrice tests ──────────────────────────────────────────────────

describe("computeRoutePrice — price bounds", () => {
  const baseManifest = {
    skill_id: "test-skill",
    endpoints: [VERIFIED_ENDPOINT],
    owner_compensation_opt_in: false as const,
  };

  it("price is always >= MIN_PRICE_USD", () => {
    const result = computeRoutePrice({ ...baseManifest, base_price_usd: 0.000001 }, [makeStats(0, 0)]);
    expect(result.price_usd).toBeGreaterThanOrEqual(MIN_PRICE_USD);
  });

  it("price is always <= MAX_PRICE_USD", () => {
    const result = computeRoutePrice({ ...baseManifest, base_price_usd: 1000 }, [makeStats(1_000_000, 1_000_000)]);
    expect(result.price_usd).toBeLessThanOrEqual(MAX_PRICE_USD);
  });

  it("new route with default base price is in reasonable range", () => {
    const result = computeRoutePrice(baseManifest, [makeStats(0, 0)]);
    expect(result.price_usd).toBeGreaterThanOrEqual(MIN_PRICE_USD);
    expect(result.price_usd).toBeLessThanOrEqual(MAX_PRICE_USD);
    // New route: demand_mult=1.0, reliability_mult=0.5 (0 successes out of 0 → avg=0)
    // price = DEFAULT_BASE × 1.0 × 0.5
    expect(result.price_usd).toBeCloseTo(DEFAULT_BASE_PRICE_USD * 1.0 * 0.5, 6);
  });

  it("high-demand reliable route costs more than new route", () => {
    const newRoute = computeRoutePrice(baseManifest, [makeStats(0, 0)]);
    const hotRoute = computeRoutePrice(baseManifest, [makeStats(10_000, 9_500)]);
    expect(hotRoute.price_usd).toBeGreaterThan(newRoute.price_usd);
  });

  it("higher reliability yields higher price (more valuable route)", () => {
    const lowRel  = computeRoutePrice(baseManifest, [makeStats(100, 50)]);
    const highRel = computeRoutePrice(baseManifest, [makeStats(100, 95)]);
    expect(highRel.price_usd).toBeGreaterThan(lowRel.price_usd);
  });

  it("custom base_price_usd overrides the platform default", () => {
    const custom = computeRoutePrice({ ...baseManifest, base_price_usd: 0.005 }, [makeStats(0, 0)]);
    const def    = computeRoutePrice(baseManifest, [makeStats(0, 0)]);
    expect(custom.price_usd).toBeGreaterThan(def.price_usd);
  });
});

describe("computeRoutePrice — site-owner compensation", () => {
  const manifest = {
    skill_id: "opt-in-skill",
    endpoints: [VERIFIED_ENDPOINT],
  };

  it("site_owner_share_usd = 0 when opt-in is false", () => {
    const result = computeRoutePrice({ ...manifest, owner_compensation_opt_in: false }, [makeStats(100, 90)]);
    expect(result.site_owner_share_usd).toBe(0);
    expect(result.owner_compensation_opt_in).toBe(false);
  });

  it("site_owner_share_usd = 0 when opt-in is absent", () => {
    const result = computeRoutePrice(manifest, [makeStats(100, 90)]);
    expect(result.site_owner_share_usd).toBe(0);
    expect(result.owner_compensation_opt_in).toBe(false);
  });

  it("site_owner_share_usd = SITE_OWNER_SHARE_PCT × price when opted in", () => {
    const result = computeRoutePrice({ ...manifest, owner_compensation_opt_in: true }, [makeStats(100, 90)]);
    expect(result.owner_compensation_opt_in).toBe(true);
    expect(result.site_owner_share_usd).toBeCloseTo(result.price_usd * SITE_OWNER_SHARE_PCT, 10);
  });

  it("site owner share is always less than total price", () => {
    const result = computeRoutePrice({ ...manifest, owner_compensation_opt_in: true }, [makeStats(1000, 900)]);
    expect(result.site_owner_share_usd).toBeLessThan(result.price_usd);
  });
});

describe("computeRoutePrice — result shape", () => {
  it("returns all required fields", () => {
    const result = computeRoutePrice(
      { skill_id: "s1", endpoints: [VERIFIED_ENDPOINT], owner_compensation_opt_in: true },
      [makeStats(500, 450)],
    );
    expect(result.skill_id).toBe("s1");
    expect(typeof result.price_usd).toBe("number");
    expect(result.price_display).toMatch(/^\$\d+\.\d{6}$/);
    expect(typeof result.breakdown.demand_multiplier).toBe("number");
    expect(typeof result.breakdown.reliability_multiplier).toBe("number");
    expect(typeof result.total_executions).toBe("number");
    expect(typeof result.avg_reliability_score).toBe("number");
  });

  it("prints pricing scenarios", () => {
    const scenarios = [
      { label: "New route, not opted in",     executions: 0,      successes: 0,      optIn: false },
      { label: "Growing route, opted in",     executions: 500,    successes: 450,    optIn: true  },
      { label: "Popular + reliable, opted in",executions: 10_000, successes: 9_500,  optIn: true  },
      { label: "Unreliable, high traffic",    executions: 5_000,  successes: 1_000,  optIn: false },
    ];
    console.log("\n  ── Dynamic Route Pricing Scenarios ──");
    for (const { label, executions, successes, optIn } of scenarios) {
      const r = computeRoutePrice(
        { skill_id: "s", endpoints: [VERIFIED_ENDPOINT], owner_compensation_opt_in: optIn },
        [makeStats(executions, successes)],
      );
      console.log(
        `  ${label}:\n` +
        `    price=${r.price_display}  demand×${r.breakdown.demand_multiplier.toFixed(2)}` +
        `  reliability×${r.breakdown.reliability_multiplier.toFixed(2)}` +
        `  owner_share=$${r.site_owner_share_usd.toFixed(6)}`,
      );
    }
    expect(true).toBe(true);
  });
});
