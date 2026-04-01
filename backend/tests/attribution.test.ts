/**
 * Tier 1 delta-based contribution attribution tests — issue #98
 *
 * Tests the pure delta computation logic without hitting KV.
 *
 * Run:
 *   bun test backend/tests/attribution.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  computeAttribution,
  BASE_FEE_UC,
  DELTA_BONUS_UC,
} from "../src/services/attribution.js";

describe("computeAttribution — delta score calculation", () => {
  it("returns delta=0 when chosen equals next best (replaceable route)", () => {
    const { delta_score } = computeAttribution(0.8, 0.8);
    expect(delta_score).toBe(0);
  });

  it("returns delta=0 when next best is higher (shouldn't happen but is safe)", () => {
    const { delta_score } = computeAttribution(0.5, 0.9);
    expect(delta_score).toBe(0);
  });

  it("returns delta=1 when next best is 0 (unique route)", () => {
    const { delta_score } = computeAttribution(1.0, 0.0);
    expect(delta_score).toBe(1);
  });

  it("returns fractional delta for partial differentiation", () => {
    const { delta_score } = computeAttribution(0.9, 0.5);
    expect(delta_score).toBeCloseTo(0.4, 5);
  });

  it("clamps delta to [0, 1] even with out-of-range inputs", () => {
    const { delta_score: low } = computeAttribution(0, 1.5);
    const { delta_score: high } = computeAttribution(1.5, 0);
    expect(low).toBe(0);
    expect(high).toBe(1);
  });
});

describe("computeAttribution — fee allocation", () => {
  it("minimum fee is BASE_FEE_UC when delta=0 (replaceable route)", () => {
    const { fee_allocated_uc } = computeAttribution(0.8, 0.8);
    expect(fee_allocated_uc).toBe(BASE_FEE_UC);
  });

  it("maximum fee is BASE_FEE_UC + DELTA_BONUS_UC when delta=1 (unique route)", () => {
    const { fee_allocated_uc } = computeAttribution(1.0, 0.0);
    expect(fee_allocated_uc).toBe(BASE_FEE_UC + DELTA_BONUS_UC);
  });

  it("fee scales linearly with delta", () => {
    const { fee_allocated_uc: at0 }   = computeAttribution(0.5, 0.5);  // delta=0
    const { fee_allocated_uc: at05 }  = computeAttribution(0.8, 0.3);  // delta=0.5
    const { fee_allocated_uc: at1 }   = computeAttribution(1.0, 0.0);  // delta=1

    expect(at0).toBe(BASE_FEE_UC);
    expect(at05).toBe(BASE_FEE_UC + Math.round(DELTA_BONUS_UC * 0.5));
    expect(at1).toBe(BASE_FEE_UC + DELTA_BONUS_UC);
    // Monotonically increasing
    expect(at05).toBeGreaterThan(at0);
    expect(at1).toBeGreaterThan(at05);
  });

  it("fee is always a positive integer", () => {
    const samples = [
      computeAttribution(0.9, 0.85),
      computeAttribution(0.7, 0.1),
      computeAttribution(0.5, 0.5),
      computeAttribution(1.0, 0.0),
    ];
    for (const { fee_allocated_uc } of samples) {
      expect(Number.isInteger(fee_allocated_uc)).toBe(true);
      expect(fee_allocated_uc).toBeGreaterThan(0);
    }
  });

  it("fee is never less than BASE_FEE_UC", () => {
    for (let r = 0; r <= 1; r += 0.1) {
      for (let n = 0; n <= r; n += 0.1) {
        const { fee_allocated_uc } = computeAttribution(r, n);
        expect(fee_allocated_uc).toBeGreaterThanOrEqual(BASE_FEE_UC);
      }
    }
  });

  it("fee is never greater than BASE_FEE_UC + DELTA_BONUS_UC", () => {
    const { fee_allocated_uc } = computeAttribution(1.0, 0.0);
    expect(fee_allocated_uc).toBeLessThanOrEqual(BASE_FEE_UC + DELTA_BONUS_UC);
  });
});

describe("Attribution economics", () => {
  it("unique route earns 4x the fee of a replaceable route", () => {
    const { fee_allocated_uc: unique }      = computeAttribution(1.0, 0.0);  // delta=1
    const { fee_allocated_uc: replaceable } = computeAttribution(0.8, 0.8);  // delta=0
    // BASE=50, BONUS=150 → unique=200, replaceable=50 → ratio=4
    expect(unique / replaceable).toBe((BASE_FEE_UC + DELTA_BONUS_UC) / BASE_FEE_UC);
  });

  it("prints fee schedule summary", () => {
    const examples = [
      { label: "Replaceable route (delta=0.0)", r: 0.8, n: 0.8 },
      { label: "Moderate lift   (delta=0.2)", r: 0.8, n: 0.6 },
      { label: "Strong lift     (delta=0.5)", r: 0.8, n: 0.3 },
      { label: "Unique route    (delta=1.0)", r: 1.0, n: 0.0 },
    ];
    console.log("\n  ── Tier 1 Attribution Fee Schedule ──");
    for (const { label, r, n } of examples) {
      const { delta_score, fee_allocated_uc } = computeAttribution(r, n);
      const usd = (fee_allocated_uc / 1_000_000).toFixed(6);
      console.log(`  ${label}: δ=${delta_score.toFixed(2)} → ${fee_allocated_uc} µ¢ ($${usd})`);
    }
    expect(true).toBe(true);
  });
});
