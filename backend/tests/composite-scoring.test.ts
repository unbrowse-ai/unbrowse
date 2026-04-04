import { describe, test, expect } from "bun:test";
import { computeCompositeSearchScore } from "../src/services/scoring.js";

describe("#103 composite search scoring", () => {
  test("high vector similarity + reliable + fresh + verified scores highest", () => {
    const score = computeCompositeSearchScore(0.95, 0.95, new Date().toISOString(), 1.0);
    expect(score).toBeGreaterThan(0.85);
  });

  test("high vector but stale and unreliable scores lower", () => {
    const good = computeCompositeSearchScore(0.95, 0.95, new Date().toISOString(), 1.0);
    const bad = computeCompositeSearchScore(0.95, 0.2, new Date(Date.now() - 90 * 86400000).toISOString(), 0.0);
    expect(bad).toBeLessThan(good);
  });

  test("moderate vector but very reliable beats high vector + unreliable", () => {
    const reliable = computeCompositeSearchScore(0.7, 0.99, new Date(Date.now() - 2 * 86400000).toISOString(), 1.0);
    const unreliable = computeCompositeSearchScore(0.9, 0.1, new Date(Date.now() - 60 * 86400000).toISOString(), 0.0);
    expect(reliable).toBeGreaterThan(unreliable);
  });

  test("freshness decays over time", () => {
    const fresh = computeCompositeSearchScore(0.8, 0.8, new Date(Date.now() - 86400000).toISOString(), 0.5);
    const stale = computeCompositeSearchScore(0.8, 0.8, new Date(Date.now() - 90 * 86400000).toISOString(), 0.5);
    expect(fresh).toBeGreaterThan(stale);
  });

  test("score is clamped to [0, 1]", () => {
    const score = computeCompositeSearchScore(2.0, 2.0, new Date().toISOString(), 2.0);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
