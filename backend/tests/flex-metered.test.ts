/**
 * Pure-function tests for backend/src/services/flex-metered.ts
 *
 * No env, no IO, no facilitator — just the µ¢ arithmetic and the
 * legacy-`base_price_usd` fallback. The route layer is tested
 * separately in flex-route-helpers (Worker 2's surface).
 */

import { describe, expect, test } from "bun:test";
import {
  computeActualAmountUc,
  computeMaxAmountUc,
  resolveSkillPricing,
} from "../src/services/flex-metered.js";
import type { SkillManifest } from "../src/types.js";

function makeSkill(overrides: Partial<SkillManifest>): SkillManifest {
  return {
    skill_id: "test/skill",
    version: "1.0.0",
    schema_version: "1",
    name: "test",
    intent_signature: "test",
    domain: "test.com",
    description: "test",
    owner_type: "agent",
    execution_type: "http",
    endpoints: [],
    lifecycle: "active",
    created_at: "2026-05-14T00:00:00Z",
    updated_at: "2026-05-14T00:00:00Z",
    ...overrides,
  } as SkillManifest;
}

describe("resolveSkillPricing", () => {
  test("returns literal `pricing` field when present (metered)", () => {
    const skill = makeSkill({
      pricing: { mode: "metered", unit: "input_token", cost_per_unit_uc: 10, max_units: 1000 },
    });
    const r = resolveSkillPricing(skill);
    expect(r.mode).toBe("metered");
    if (r.mode !== "metered") throw new Error("narrowing failed");
    expect(r.unit).toBe("input_token");
    expect(r.cost_per_unit_uc).toBe(10);
    expect(r.max_units).toBe(1000);
  });

  test("returns literal `pricing` field when present (fixed)", () => {
    const skill = makeSkill({ pricing: { mode: "fixed", price_usd: 0.05 } });
    const r = resolveSkillPricing(skill);
    expect(r).toEqual({ mode: "fixed", price_usd: 0.05 });
  });

  test("falls back to legacy base_price_usd as fixed pricing", () => {
    const skill = makeSkill({ base_price_usd: 0.01 });
    const r = resolveSkillPricing(skill);
    expect(r).toEqual({ mode: "fixed", price_usd: 0.01 });
  });

  test("returns fixed/0 when neither pricing nor base_price_usd is set", () => {
    const skill = makeSkill({});
    const r = resolveSkillPricing(skill);
    expect(r).toEqual({ mode: "fixed", price_usd: 0 });
  });

  test("prefers `pricing` over legacy `base_price_usd` when both set", () => {
    const skill = makeSkill({
      base_price_usd: 0.99,
      pricing: { mode: "fixed", price_usd: 0.01 },
    });
    const r = resolveSkillPricing(skill);
    expect(r).toEqual({ mode: "fixed", price_usd: 0.01 });
  });
});

describe("computeMaxAmountUc", () => {
  test("fixed: $0.01 maps to 10_000 µ¢", () => {
    const uc = computeMaxAmountUc({ mode: "fixed", price_usd: 0.01 });
    expect(uc).toBe(10_000n);
  });

  test("fixed: $1.00 maps to 1_000_000 µ¢", () => {
    const uc = computeMaxAmountUc({ mode: "fixed", price_usd: 1 });
    expect(uc).toBe(1_000_000n);
  });

  test("fixed: $0.00 floors to 1 µ¢ (minimum, never zero)", () => {
    const uc = computeMaxAmountUc({ mode: "fixed", price_usd: 0 });
    expect(uc).toBe(1n);
  });

  test("metered: 100 units × 10 µ¢/unit = 1000 µ¢", () => {
    const uc = computeMaxAmountUc({
      mode: "metered",
      unit: "tok",
      cost_per_unit_uc: 10,
      max_units: 100,
    });
    expect(uc).toBe(1000n);
  });

  test("metered: large ceiling stays bigint-safe", () => {
    // 1M units × 1000 µ¢/unit = 1B µ¢ = $1000 — well within bigint precision.
    const uc = computeMaxAmountUc({
      mode: "metered",
      unit: "tok",
      cost_per_unit_uc: 1000,
      max_units: 1_000_000,
    });
    expect(uc).toBe(1_000_000_000n);
  });
});

describe("computeActualAmountUc", () => {
  test("fixed: actual ignores usedUnits and returns ceiling", () => {
    const pricing = { mode: "fixed" as const, price_usd: 0.05 };
    expect(computeActualAmountUc(pricing, 0)).toBe(50_000n);
    expect(computeActualAmountUc(pricing, 9999)).toBe(50_000n);
  });

  test("metered: 50 units × 10 µ¢/unit = 500 µ¢", () => {
    const actual = computeActualAmountUc(
      { mode: "metered", unit: "tok", cost_per_unit_uc: 10, max_units: 100 },
      50,
    );
    expect(actual).toBe(500n);
  });

  test("metered: 0 units settles to 0 µ¢", () => {
    const actual = computeActualAmountUc(
      { mode: "metered", unit: "tok", cost_per_unit_uc: 10, max_units: 100 },
      0,
    );
    expect(actual).toBe(0n);
  });

  test("metered: fractional units round up", () => {
    // 0.1 units consumed → ceil → 1 unit → 10 µ¢
    const actual = computeActualAmountUc(
      { mode: "metered", unit: "tok", cost_per_unit_uc: 10, max_units: 100 },
      0.1,
    );
    expect(actual).toBe(10n);
  });

  test("metered: negative usedUnits clamps to 0", () => {
    const actual = computeActualAmountUc(
      { mode: "metered", unit: "tok", cost_per_unit_uc: 10, max_units: 100 },
      -5,
    );
    expect(actual).toBe(0n);
  });
});
