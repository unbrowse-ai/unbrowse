/**
 * x402-gate doctrine tests — single-lever, no env escape hatches.
 *
 * PR #816: the env-var escape hatches (`PAYMENTS_ENABLED`,
 * `X402_SEARCH_ENABLED`) were REMOVED. They were footguns — a stale
 * wrangler.toml entry could accidentally flip the substrate between paid
 * and free modes. The doctrine is now:
 *
 *   - Indexing is ALWAYS free. Period.
 *   - Per-skill 402 fires ONLY when the skill manifest has
 *     `owner_compensation_opt_in = true` (DNS claim + wallet binding).
 *   - Search is always free indexing (no per-query toll).
 *   - There is no operator-side env knob to flip.
 *
 * What this file tests:
 *   - The Env type no longer carries PAYMENTS_ENABLED / X402_SEARCH_ENABLED.
 *   - The middleware no longer exports paymentsEnabled / searchPaymentsEnabled.
 *   - The pricing.ts gate IS the source of truth: price_usd > 0 iff
 *     owner_compensation_opt_in === true.
 *   - The wrangler.toml has zero references to the removed env names.
 *   - x402UseTestnet still works (it's a different concern — testnet/mainnet
 *     selector, NOT a payment gate).
 */
import { describe, it, expect } from "bun:test";
import { x402UseTestnet } from "../src/middleware/x402-gate.js";
import { computeRoutePrice } from "../src/services/pricing.js";
import type { EndpointStats, SkillManifest } from "../src/types.js";

function makeStats(total = 0, ok = 0): EndpointStats {
  return {
    total_executions: total,
    successful_executions: ok,
    consecutive_failures: 0,
    avg_latency_ms: 100,
    feedback_sum: 0,
    feedback_count: 0,
    drift_count: 0,
  };
}

function baseSkill(extra: Partial<SkillManifest> = {}): SkillManifest {
  return {
    skill_id: "test-skill",
    endpoints: [
      {
        endpoint_id: "ep-1",
        method: "GET",
        url_template: "https://example.com/api",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
    ],
    ...extra,
  } as SkillManifest;
}

// ─── Per-skill opt-in IS the only lever ─────────────────────────────────────

describe("indexing-mode doctrine (PR #816, no env escape hatches)", () => {
  it("default (no opt-in) → price_usd = 0 → route returns 200", () => {
    const result = computeRoutePrice(baseSkill(), [makeStats(0, 0)]);
    expect(result.price_usd).toBe(0);
    expect(result.owner_compensation_opt_in).toBe(false);
    // Route gate: `if (price_usd > 0)` → false → free path
  });

  it("opt-in true → price_usd > 0 → route emits 402", () => {
    const result = computeRoutePrice(
      baseSkill({ owner_compensation_opt_in: true }),
      [makeStats(100, 90)],
    );
    expect(result.price_usd).toBeGreaterThan(0);
    expect(result.owner_compensation_opt_in).toBe(true);
    // Route gate: `if (price_usd > 0)` → true → 402 Flex envelope
  });

  it("opt-in false is preserved on high-traffic skills too", () => {
    const result = computeRoutePrice(
      baseSkill({ owner_compensation_opt_in: false }),
      [makeStats(10_000, 9_500)],
    );
    expect(result.price_usd).toBe(0);
  });

  it("opt-in absent (undefined) is the same as false", () => {
    const result = computeRoutePrice(baseSkill(), [makeStats(100, 90)]);
    expect(result.price_usd).toBe(0);
  });
});

// ─── No env-var escape hatches survive ───────────────────────────────────────

describe("env-var escape hatches are gone (no footguns)", () => {
  it("middleware/x402-gate.ts no longer exports paymentsEnabled", async () => {
    const mod: Record<string, unknown> = await import("../src/middleware/x402-gate.js");
    expect(mod.paymentsEnabled).toBeUndefined();
    expect(mod.searchPaymentsEnabled).toBeUndefined();
    // What SHOULD still be exported:
    expect(mod.x402UseTestnet).toBeDefined();
    expect((mod as { X402PaymentRequirementV2?: unknown }).X402PaymentRequirementV2).toBeUndefined();
    // (X402PaymentRequirementV2 is a type-only export; not in runtime mod)
  });

  it("Env type no longer declares PAYMENTS_ENABLED or X402_SEARCH_ENABLED", async () => {
    // We can't introspect TS types at runtime, but we CAN assert the
    // canonical types.ts file no longer mentions them.
    const candidates = ["backend/src/types.ts", "src/types.ts", "../backend/src/types.ts"];
    let typesSource = "";
    for (const path of candidates) {
      const file = Bun.file(path);
      if (await file.exists()) {
        typesSource = await file.text();
        break;
      }
    }
    expect(typesSource.length).toBeGreaterThan(0);
    // The Env interface must not declare these any more.
    expect(typesSource).not.toMatch(/^\s*PAYMENTS_ENABLED\?:/m);
    expect(typesSource).not.toMatch(/^\s*X402_SEARCH_ENABLED\?:/m);
  });

  it("wrangler.toml has zero PAYMENTS_ENABLED / X402_SEARCH_ENABLED entries (in any env block)", async () => {
    const candidates = ["backend/wrangler.toml", "wrangler.toml", "../backend/wrangler.toml"];
    let wranglerToml = "";
    for (const path of candidates) {
      const file = Bun.file(path);
      if (await file.exists()) {
        wranglerToml = await file.text();
        break;
      }
    }
    expect(wranglerToml.length).toBeGreaterThan(0);
    // Doctrine: every wrangler env block (prod, staging, experiments,
    // gate-staging) must be free of these names. A regression where
    // someone re-adds the line gets caught here.
    expect(wranglerToml).not.toMatch(/^\s*PAYMENTS_ENABLED\s*=/m);
    expect(wranglerToml).not.toMatch(/^\s*X402_SEARCH_ENABLED\s*=/m);
  });
});

// ─── x402UseTestnet is NOT a payment gate (network selector, kept) ─────────

describe("x402UseTestnet (network selector, NOT a payment gate)", () => {
  it("returns mainnet (false) for production env", () => {
    expect(x402UseTestnet({ ENVIRONMENT: "production" })).toBe(false);
  });

  it("returns testnet (true) for any non-production env by default", () => {
    expect(x402UseTestnet({ ENVIRONMENT: "staging" })).toBe(true);
    expect(x402UseTestnet({ ENVIRONMENT: "dev" })).toBe(true);
    expect(x402UseTestnet({})).toBe(true);
  });

  it("explicit X402_NETWORK_MODE overrides the env-based default", () => {
    expect(x402UseTestnet({ ENVIRONMENT: "production", X402_NETWORK_MODE: "testnet" })).toBe(true);
    expect(x402UseTestnet({ ENVIRONMENT: "staging", X402_NETWORK_MODE: "mainnet" })).toBe(false);
  });
});
