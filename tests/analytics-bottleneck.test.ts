import { describe, test, expect } from "bun:test";
import { computeBottleneckMetrics, computePercentile } from "../backend/src/services/analytics.js";

describe("#123 analytics bottleneck metrics", () => {
  test("computes percentiles correctly", () => {
    expect(computePercentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(computePercentile([10, 20, 30, 40, 50], 95)).toBe(50);
  });

  test("computes bottleneck metrics", () => {
    const metrics = computeBottleneckMetrics(
      [100, 200, 300, 400, 500],
      [50, 100, 150],
      [10, 20, 30],
      60, 25, 15, 5, 100, 10, 50,
    );
    expect(metrics.cache_hit_rate).toBe(0.6);
    expect(metrics.marketplace_hit_rate).toBe(0.25);
    expect(metrics.failure_rate).toBe(0.05);
    expect(metrics.skills_per_domain).toBe(5);
  });

  test("handles empty data", () => {
    const metrics = computeBottleneckMetrics([], [], [], 0, 0, 0, 0, 0, 0, 0);
    expect(metrics.cache_hit_rate).toBe(0);
    expect(metrics.capture_latency_p50_ms).toBe(0);
  });
});
