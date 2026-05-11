/**
 * Tests for consecutive failure → auto-deprecation threshold logic (Feature #99).
 */
import { describe, it, expect } from "bun:test";
import { computeReliabilityScore, DEPRECATION_THRESHOLD, executionFailureWeight } from "../src/services/scoring.js";
import type { EndpointStats, ExecutionTrace } from "../src/types.js";

function makeStats(overrides: Partial<EndpointStats> = {}): EndpointStats {
  return {
    total_executions: 0,
    successful_executions: 0,
    consecutive_failures: 0,
    avg_latency_ms: 0,
    feedback_sum: 0,
    feedback_count: 0,
    drift_count: 0,
    ...overrides,
  };
}

describe("DEPRECATION_THRESHOLD", () => {
  it("exports the expected threshold values", () => {
    expect(DEPRECATION_THRESHOLD.consecutive_failures).toBe(5);
    expect(DEPRECATION_THRESHOLD.min_score).toBe(0.2);
  });
});

describe("computeReliabilityScore + deprecation gate", () => {
  it("should_disable is false at threshold - 1 consecutive failures", () => {
    const stats = makeStats({
      total_executions: 10,
      successful_executions: 0,
      consecutive_failures: DEPRECATION_THRESHOLD.consecutive_failures - 1,
    });
    const score = computeReliabilityScore(stats);
    const shouldDisable =
      stats.consecutive_failures >= DEPRECATION_THRESHOLD.consecutive_failures &&
      score < DEPRECATION_THRESHOLD.min_score;
    expect(shouldDisable).toBe(false);
  });

  it("should_disable is true at exactly the threshold with low score", () => {
    const stats = makeStats({
      total_executions: 20,
      successful_executions: 0,
      consecutive_failures: DEPRECATION_THRESHOLD.consecutive_failures,
    });
    const score = computeReliabilityScore(stats);
    expect(score).toBeLessThan(DEPRECATION_THRESHOLD.min_score);
    const shouldDisable =
      stats.consecutive_failures >= DEPRECATION_THRESHOLD.consecutive_failures &&
      score < DEPRECATION_THRESHOLD.min_score;
    expect(shouldDisable).toBe(true);
  });

  it("should_disable is false when consecutive_failures is below threshold even with low score", () => {
    // 4 failures (threshold - 1) — gate should not trigger regardless of score
    const stats = makeStats({
      total_executions: 10,
      successful_executions: 0,
      consecutive_failures: DEPRECATION_THRESHOLD.consecutive_failures - 1,
    });
    const score = computeReliabilityScore(stats);
    const shouldDisable =
      stats.consecutive_failures >= DEPRECATION_THRESHOLD.consecutive_failures &&
      score < DEPRECATION_THRESHOLD.min_score;
    expect(shouldDisable).toBe(false);
  });

  it("a success resets consecutive_failures to 0", () => {
    const stats = makeStats({
      total_executions: 10,
      successful_executions: 5,
      consecutive_failures: 4,
    });
    // Simulate a success
    stats.successful_executions++;
    stats.consecutive_failures = 0;
    stats.total_executions++;
    expect(stats.consecutive_failures).toBe(0);
    const score = computeReliabilityScore(stats);
    const shouldDisable =
      stats.consecutive_failures >= DEPRECATION_THRESHOLD.consecutive_failures &&
      score < DEPRECATION_THRESHOLD.min_score;
    expect(shouldDisable).toBe(false);
  });

  it("auto_deprecated_at field exists on EndpointStats type", () => {
    const stats: EndpointStats = makeStats({ auto_deprecated_at: new Date().toISOString() });
    expect(stats.auto_deprecated_at).toBeDefined();
  });

  it("hard marketplace failures decay reliability faster than soft mismatches", () => {
    const hardTrace = {
      trace_id: "hard",
      skill_id: "s",
      endpoint_id: "e",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: false,
      status_code: 403,
    } satisfies ExecutionTrace;
    const softTrace = {
      ...hardTrace,
      trace_id: "soft",
      status_code: 422,
    } satisfies ExecutionTrace;

    expect(executionFailureWeight(hardTrace)).toBe(3);
    expect(executionFailureWeight(softTrace)).toBe(1);
  });

  it("treats trigger_timeout, endpoint_not_found, stale_endpoint, and vendor_blocked errors as hard failures", () => {
    const base = {
      trace_id: "x",
      skill_id: "s",
      endpoint_id: "e",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      success: false,
      status_code: 0,
    } as const;

    expect(executionFailureWeight({ ...base, error: "trigger_timeout" } satisfies ExecutionTrace)).toBe(3);
    expect(executionFailureWeight({ ...base, error: "endpoint_not_found" } satisfies ExecutionTrace)).toBe(3);
    expect(executionFailureWeight({ ...base, error: "stale_endpoint" } satisfies ExecutionTrace)).toBe(3);
    expect(executionFailureWeight({
      ...base,
      error: "HTTP 403 (vendor_blocked: datadome — refreshed cookies still classified as bot)",
    } satisfies ExecutionTrace)).toBe(3);

    // Unknown / transient errors stay at weight 1
    expect(executionFailureWeight({ ...base, error: "network_blip" } satisfies ExecutionTrace)).toBe(1);
  });
});
