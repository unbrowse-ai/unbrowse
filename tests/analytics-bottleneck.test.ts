import { describe, test, expect } from "bun:test";

interface BottleneckMetrics {
  capture_latency_p50_ms: number;
  capture_latency_p95_ms: number;
  resolve_latency_p50_ms: number;
  resolve_latency_p95_ms: number;
  execute_latency_p50_ms: number;
  execute_latency_p95_ms: number;
  cache_hit_rate: number;
  marketplace_hit_rate: number;
  live_capture_rate: number;
  failure_rate: number;
  skills_per_domain: number;
}

function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function computeBottleneckMetrics(
  captures: number[],
  resolves: number[],
  executes: number[],
  cacheHits: number,
  marketplaceHits: number,
  liveCaptures: number,
  failures: number,
  totalRequests: number,
  uniqueDomains: number,
  totalSkills: number,
): BottleneckMetrics {
  return {
    capture_latency_p50_ms: computePercentile(captures, 50),
    capture_latency_p95_ms: computePercentile(captures, 95),
    resolve_latency_p50_ms: computePercentile(resolves, 50),
    resolve_latency_p95_ms: computePercentile(resolves, 95),
    execute_latency_p50_ms: computePercentile(executes, 50),
    execute_latency_p95_ms: computePercentile(executes, 95),
    cache_hit_rate: totalRequests > 0 ? cacheHits / totalRequests : 0,
    marketplace_hit_rate: totalRequests > 0 ? marketplaceHits / totalRequests : 0,
    live_capture_rate: totalRequests > 0 ? liveCaptures / totalRequests : 0,
    failure_rate: totalRequests > 0 ? failures / totalRequests : 0,
    skills_per_domain: uniqueDomains > 0 ? totalSkills / uniqueDomains : 0,
  };
}

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
