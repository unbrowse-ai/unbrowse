/**
 * tests/composite-scoring.test.ts — P2 Wave-1 done-when invariants.
 *
 * Asserts the three explicit done-when bullets from PAPER_PLAN.md §P2:
 *
 *   1. composite(1, 1, 1, 1) === 1; weights sum to 1.
 *   2. ranker output for a fixture matches the paper's 40/30/15/15
 *      weighted ordering (this loop: prove the math; runtime ordering
 *      lands when P2 W2 wires composite into rankEndpoints).
 *   3. `grep -n "0\.4\|0\.3\|0\.15" src/ranking/` shows the four
 *      constants in one file (assertion #4 below: filesystem check).
 *
 * Plus freshness invariants from §6.3.
 *
 * Run: bun test tests/composite-scoring.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  COMPOSITE_WEIGHTS,
  composite,
  weightsSumToOne,
  WEIGHT_FRESHNESS,
  WEIGHT_RELIABILITY,
  WEIGHT_SIM,
  WEIGHT_VERIFICATION,
} from "../src/ranking/composite.js";

import {
  freshness,
  freshnessFromDate,
} from "../src/lib/freshness.js";

const REPO_ROOT = join(import.meta.dir, "..");

describe("P2 W1: composite weights — paper §3.3", () => {
  it("the four weights are 0.4 / 0.3 / 0.15 / 0.15", () => {
    expect(WEIGHT_SIM).toBe(0.4);
    expect(WEIGHT_RELIABILITY).toBe(0.3);
    expect(WEIGHT_FRESHNESS).toBe(0.15);
    expect(WEIGHT_VERIFICATION).toBe(0.15);
    expect(COMPOSITE_WEIGHTS.sim).toBe(0.4);
    expect(COMPOSITE_WEIGHTS.reliability).toBe(0.3);
    expect(COMPOSITE_WEIGHTS.freshness).toBe(0.15);
    expect(COMPOSITE_WEIGHTS.verification).toBe(0.15);
  });

  it("weights sum to 1", () => {
    expect(weightsSumToOne()).toBe(true);
  });

  it("composite(1, 1, 1, 1) === 1 (paper-stated identity)", () => {
    expect(composite(1, 1, 1, 1)).toBeCloseTo(1, 9);
  });

  it("composite(0, 0, 0, 0) === 0", () => {
    expect(composite(0, 0, 0, 0)).toBe(0);
  });

  it("composite is linear in each input independently", () => {
    expect(composite(1, 0, 0, 0)).toBeCloseTo(WEIGHT_SIM, 9);
    expect(composite(0, 1, 0, 0)).toBeCloseTo(WEIGHT_RELIABILITY, 9);
    expect(composite(0, 0, 1, 0)).toBeCloseTo(WEIGHT_FRESHNESS, 9);
    expect(composite(0, 0, 0, 1)).toBeCloseTo(WEIGHT_VERIFICATION, 9);
  });

  it("ranker fixture: 40/30/15/15 ordering — sim dominates over reliability dominates over freshness/verification", () => {
    const a = composite(1.0, 0.0, 0.0, 0.0);
    const b = composite(0.0, 1.0, 0.0, 0.0);
    const c = composite(0.0, 0.0, 1.0, 0.0);
    const d = composite(0.0, 0.0, 0.0, 1.0);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(c).toBeCloseTo(d, 9);
  });
});

describe("P2 W1: freshness decay — paper §6.3 formula 1/(1 + d/30)", () => {
  it("freshness(0) === 1.0", () => {
    expect(freshness(0)).toBeCloseTo(1, 9);
  });

  it("freshness(30) === 0.5", () => {
    expect(freshness(30)).toBeCloseTo(0.5, 9);
  });

  it("freshness(60) === 1/3", () => {
    expect(freshness(60)).toBeCloseTo(1 / 3, 9);
  });

  it("freshness is monotonically non-increasing", () => {
    let prev = freshness(0);
    for (const d of [1, 5, 10, 30, 60, 365, 1000]) {
      const v = freshness(d);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });

  it("freshness never goes negative", () => {
    for (const d of [0, 30, 365, 1e6, 1e9]) {
      expect(freshness(d)).toBeGreaterThanOrEqual(0);
    }
  });

  it("freshness(Infinity) → 0", () => {
    expect(freshness(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("freshness clamps negative input (future timestamp) to 1", () => {
    expect(freshness(-5)).toBeCloseTo(1, 9);
  });

  it("freshnessFromDate returns 1 when lastSeen === now", () => {
    const now = new Date("2026-01-01T00:00:00Z").getTime();
    expect(freshnessFromDate(now, now)).toBeCloseTo(1, 9);
  });

  it("freshnessFromDate returns 0.5 at 30 days ago", () => {
    const now = new Date("2026-02-01T00:00:00Z").getTime();
    const lastSeen = now - 30 * 24 * 60 * 60 * 1000;
    expect(freshnessFromDate(lastSeen, now)).toBeCloseTo(0.5, 9);
  });
});

describe("P2 W1: greppable constants invariant — paper-table greppability", () => {
  it("src/ranking/composite.ts exposes the four numeric weights as constants in one file", () => {
    const text = readFileSync(
      join(REPO_ROOT, "src/ranking/composite.ts"),
      "utf8",
    );
    expect(text).toMatch(/0\.4/);
    expect(text).toMatch(/0\.3/);
    // 0.15 appears twice (freshness + verification)
    const fifteens = text.match(/0\.15/g) ?? [];
    expect(fifteens.length).toBeGreaterThanOrEqual(2);
  });

  it("composite stays a pure-function module (no runtime side effects)", () => {
    const text = readFileSync(
      join(REPO_ROOT, "src/ranking/composite.ts"),
      "utf8",
    );
    expect(text).not.toMatch(/import .*api\(/);
    expect(text).not.toMatch(/fetch\(/);
    expect(text).not.toMatch(/process\./);
  });
});
