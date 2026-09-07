// Falsifier for the reliability-update Bayesian smoother. Per the
// CLAUDE.md substrate-enables principle, agent reflect calls drive
// reliability; this module is the pure helper translating an outcome
// into a posterior score. Tests verify convergence properties + the
// HTTP-coarse fallback for non-agent callers.
import { describe, expect, it } from "bun:test";
import {
  applyReliabilityUpdate,
  outcomeFromHttp,
  RELIABILITY_PRIOR_N,
} from "../src/marketplace/reliability.ts";

describe("applyReliabilityUpdate — Bayesian smoothing", () => {
  it("achieved nudges score UP from neutral 0.5 prior", () => {
    const after = applyReliabilityUpdate(0.5, "achieved");
    expect(after).toBeGreaterThan(0.5);
    expect(after).toBeLessThan(1);
    // Expected: (10*0.5 + 1)/(11) = 6/11 ≈ 0.545
    expect(after).toBeCloseTo(0.5455, 3);
  });

  it("failed nudges score DOWN from neutral 0.5 prior", () => {
    const after = applyReliabilityUpdate(0.5, "failed");
    expect(after).toBeLessThan(0.5);
    expect(after).toBeGreaterThan(0);
    // Expected: (10*0.5 + 0)/(11) = 5/11 ≈ 0.4545
    expect(after).toBeCloseTo(0.4545, 3);
  });

  it("partial nudges score by half (stays close to current on neutral)", () => {
    const after = applyReliabilityUpdate(0.5, "partial");
    // Expected: (10*0.5 + 0.5)/(11) = 5.5/11 = 0.5
    expect(after).toBeCloseTo(0.5, 4);
  });

  it("converges toward observed success rate over many observations", () => {
    // Run 100 "achieved" updates. Score should approach 1.0 but be smoothed.
    let score = 0.5;
    for (let i = 0; i < 100; i++) score = applyReliabilityUpdate(score, "achieved");
    expect(score).toBeGreaterThan(0.95);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("converges toward 0 with sustained failures", () => {
    let score = 0.5;
    for (let i = 0; i < 100; i++) score = applyReliabilityUpdate(score, "failed");
    expect(score).toBeLessThan(0.05);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("alternating achieved/failed stabilizes around 0.5", () => {
    let score = 0.5;
    for (let i = 0; i < 200; i++) {
      score = applyReliabilityUpdate(score, i % 2 === 0 ? "achieved" : "failed");
    }
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.6);
  });

  it("single bad observation doesn't destroy a high-reliability endpoint", () => {
    // Start at 0.95 (well-earned), one failure should still leave it > 0.85
    const after = applyReliabilityUpdate(0.95, "failed");
    expect(after).toBeGreaterThan(0.85);
  });

  it("single good observation barely shifts a low-reliability endpoint", () => {
    // Start at 0.05 (well-failed), one success should still leave it < 0.15
    const after = applyReliabilityUpdate(0.05, "achieved");
    expect(after).toBeLessThan(0.15);
  });

  it("clamps a corrupt out-of-range current score to [0, 1]", () => {
    const above = applyReliabilityUpdate(1.5, "failed");
    expect(above).toBeLessThanOrEqual(1);
    expect(above).toBeGreaterThan(0.85); // 1.0 clamped, then nudged down

    const below = applyReliabilityUpdate(-0.5, "achieved");
    expect(below).toBeGreaterThanOrEqual(0);
    expect(below).toBeLessThan(0.15); // 0.0 clamped, then nudged up
  });

  it("RELIABILITY_PRIOR_N export is the documented smoothing window", () => {
    expect(RELIABILITY_PRIOR_N).toBe(10);
  });
});

describe("outcomeFromHttp — coarse non-agent classifier", () => {
  it("2xx + non-empty body → achieved", () => {
    expect(outcomeFromHttp(200, 1024)).toBe("achieved");
    expect(outcomeFromHttp(204, 0)).toBe("partial"); // empty body
  });

  it("4xx / 5xx → failed", () => {
    expect(outcomeFromHttp(404, 50)).toBe("failed");
    expect(outcomeFromHttp(500, 200)).toBe("failed");
    expect(outcomeFromHttp(403, 0)).toBe("failed");
  });

  it("null or missing status → partial (agent should supersede)", () => {
    expect(outcomeFromHttp(null, 100)).toBe("partial");
    expect(outcomeFromHttp(undefined, 100)).toBe("partial");
  });

  it("3xx redirects → partial (ambiguous; agent supersedes)", () => {
    expect(outcomeFromHttp(302, 0)).toBe("partial");
  });
});
