import { describe, expect, it } from "bun:test";
import { evaluateRepeatabilityGate } from "../scripts/eval-repeatability-gate.ts";

describe("repeatability gate", () => {
  it("passes when warm run hits cached fast path within budget", () => {
    const evaluation = evaluateRepeatabilityGate({
      id: "fixture-pass",
      intent: "search docs",
      final_state: "pass",
      goal_satisfied: true,
      final_reason: "document_rows",
      rounds: [
        { run_label: "cold", trace_context: { source: "live-capture", cache_hit: false } },
        { run_label: "warm", trace_context: { source: "route-cache", cache_hit: true } },
      ],
      benchmark: {
        mode: "cold-warm",
        cold: {
          label: "cold",
          final_state: "pass",
          goal_satisfied: true,
          final_reason: "document_rows",
          total_rounds: 1,
          total_ms: 12000,
          total_tokens_used: 1000,
          total_tokens_saved: 0,
          avg_tokens_saved_pct: 0,
          first_source: "live-capture",
          final_source: "live-capture",
        },
        warm: {
          label: "warm",
          final_state: "pass",
          goal_satisfied: true,
          final_reason: "document_rows",
          total_rounds: 1,
          total_ms: 3500,
          total_tokens_used: 100,
          total_tokens_saved: 900,
          avg_tokens_saved_pct: 90,
          first_source: "route-cache",
          final_source: "route-cache",
        },
        delta: {
          speedup_ms: 8500,
          speedup_ratio: 3.42,
          token_delta: 900,
          token_reduction_pct: 90,
        },
      },
    });

    expect(evaluation.ok).toBe(true);
    expect(evaluation.warm_cache_hit).toBe(true);
  });

  it("fails when benchmark block is missing", () => {
    const evaluation = evaluateRepeatabilityGate({
      id: "fixture-no-benchmark",
      intent: "search docs",
      final_state: "pass",
      goal_satisfied: true,
      final_reason: "document_rows",
      rounds: [],
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.map((failure) => failure.code)).toContain("missing_benchmark");
  });

  it("fails when warm run never reports a cache hit", () => {
    const evaluation = evaluateRepeatabilityGate({
      id: "fixture-cache-miss",
      intent: "search docs",
      final_state: "pass",
      goal_satisfied: true,
      final_reason: "document_rows",
      rounds: [
        { run_label: "cold", trace_context: { source: "live-capture", cache_hit: false } },
        { run_label: "warm", trace_context: { source: "marketplace", cache_hit: false } },
      ],
      benchmark: {
        mode: "cold-warm",
        cold: {
          label: "cold",
          final_state: "pass",
          goal_satisfied: true,
          final_reason: "document_rows",
          total_rounds: 1,
          total_ms: 8000,
          total_tokens_used: 700,
          total_tokens_saved: 0,
          avg_tokens_saved_pct: 0,
          first_source: "live-capture",
          final_source: "live-capture",
        },
        warm: {
          label: "warm",
          final_state: "pass",
          goal_satisfied: true,
          final_reason: "document_rows",
          total_rounds: 1,
          total_ms: 5000,
          total_tokens_used: 200,
          total_tokens_saved: 500,
          avg_tokens_saved_pct: 70,
          first_source: "marketplace",
          final_source: "marketplace",
        },
        delta: {
          speedup_ms: 3000,
          speedup_ratio: 1.6,
          token_delta: 500,
          token_reduction_pct: 71,
        },
      },
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.map((failure) => failure.code)).toContain("warm_cache_miss");
  });

  it("fails when warm run falls back to live capture", () => {
    const evaluation = evaluateRepeatabilityGate({
      id: "fixture-warm-live-capture",
      intent: "search docs",
      final_state: "pass",
      goal_satisfied: true,
      final_reason: "document_rows",
      rounds: [
        { run_label: "cold", trace_context: { source: "live-capture", cache_hit: false } },
        { run_label: "warm", trace_context: { source: "live-capture", cache_hit: true } },
      ],
      benchmark: {
        mode: "cold-warm",
        cold: {
          label: "cold",
          final_state: "pass",
          goal_satisfied: true,
          final_reason: "document_rows",
          total_rounds: 1,
          total_ms: 9000,
          total_tokens_used: 900,
          total_tokens_saved: 0,
          avg_tokens_saved_pct: 0,
          first_source: "live-capture",
          final_source: "live-capture",
        },
        warm: {
          label: "warm",
          final_state: "pass",
          goal_satisfied: true,
          final_reason: "document_rows",
          total_rounds: 1,
          total_ms: 8500,
          total_tokens_used: 850,
          total_tokens_saved: 50,
          avg_tokens_saved_pct: 5,
          first_source: "live-capture",
          final_source: "live-capture",
        },
        delta: {
          speedup_ms: 500,
          speedup_ratio: 1.06,
          token_delta: 50,
          token_reduction_pct: 6,
        },
      },
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.map((failure) => failure.code)).toContain("warm_source_blocked");
  });

  it("fails when warm path regresses beyond slowdown budget", () => {
    const evaluation = evaluateRepeatabilityGate({
      id: "fixture-slowdown",
      intent: "search docs",
      final_state: "pass",
      goal_satisfied: true,
      final_reason: "document_rows",
      rounds: [
        { run_label: "cold", trace_context: { source: "live-capture", cache_hit: false } },
        { run_label: "warm", trace_context: { source: "route-cache", cache_hit: true } },
      ],
      benchmark: {
        mode: "cold-warm",
        cold: {
          label: "cold",
          final_state: "pass",
          goal_satisfied: true,
          final_reason: "document_rows",
          total_rounds: 1,
          total_ms: 4000,
          total_tokens_used: 500,
          total_tokens_saved: 0,
          avg_tokens_saved_pct: 0,
          first_source: "live-capture",
          final_source: "live-capture",
        },
        warm: {
          label: "warm",
          final_state: "pass",
          goal_satisfied: true,
          final_reason: "document_rows",
          total_rounds: 1,
          total_ms: 6200,
          total_tokens_used: 450,
          total_tokens_saved: 50,
          avg_tokens_saved_pct: 10,
          first_source: "route-cache",
          final_source: "route-cache",
        },
        delta: {
          speedup_ms: -2200,
          speedup_ratio: 0.65,
          token_delta: 50,
          token_reduction_pct: 10,
        },
      },
    });

    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.map((failure) => failure.code)).toContain("warm_slowdown");
    expect(evaluation.failures.map((failure) => failure.code)).toContain("warm_cold_ratio");
  });
});
