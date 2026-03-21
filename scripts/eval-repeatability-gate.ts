#!/usr/bin/env bun

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type RepeatabilityBenchmarkGate = {
  require_benchmark?: boolean;
  require_warm_cache_hit?: boolean;
  allowed_warm_sources?: string[];
  disallowed_warm_sources?: string[];
  max_warm_total_ms?: number;
  max_warm_rounds?: number;
  max_warm_cold_ratio?: number;
  max_warm_slowdown_ms?: number;
  min_speedup_ms?: number;
};

type RawCase = {
  id: string;
  retention_signal?: string;
  sticky_rationale?: string;
  benchmark_gate?: RepeatabilityBenchmarkGate;
};

type RawSuite = {
  meta?: {
    benchmark_gate_defaults?: RepeatabilityBenchmarkGate;
  };
  cases?: RawCase[];
};

type TraceContext = {
  source?: string;
  cache_hit?: boolean;
};

type RoundRecord = {
  run_label?: "cold" | "warm";
  trace_context?: TraceContext;
};

type BenchmarkRunSummary = {
  label: "cold" | "warm";
  final_state: "pass" | "fail" | "skip" | "blocked";
  goal_satisfied: boolean;
  final_reason: string;
  total_rounds: number;
  total_ms: number;
  total_tokens_used: number;
  total_tokens_saved: number;
  avg_tokens_saved_pct: number;
  first_source?: string;
  final_source?: string;
};

type BenchmarkDelta = {
  speedup_ms: number;
  speedup_ratio?: number;
  token_delta: number;
  token_reduction_pct?: number;
};

export type AutonomousResult = {
  id: string;
  intent: string;
  final_state: "pass" | "fail" | "skip" | "blocked";
  goal_satisfied: boolean;
  final_reason: string;
  rounds: RoundRecord[];
  benchmark?: {
    mode: "cold-warm";
    cold: BenchmarkRunSummary;
    warm: BenchmarkRunSummary;
    delta: BenchmarkDelta;
  };
};

type ResultsPayload = {
  summary: {
    total: number;
    pass: number;
    fail: number;
    skip: number;
    blocked: number;
    satisfied: number;
    unsatisfied: number;
    benchmark?: boolean;
  };
  results: AutonomousResult[];
};

export type GateFailure = {
  code: string;
  detail: string;
};

export type GateEvaluation = {
  ok: boolean;
  failures: GateFailure[];
  warm_sources: string[];
  warm_cache_hit: boolean;
  warm_total_ms?: number;
  cold_total_ms?: number;
};

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_CASES = resolve(ROOT, "evals", "codex-cases.repeatability.json");
const DEFAULT_OUT = resolve(ROOT, "evals", "codex-repeatability-last-run.json");

const argv = process.argv.slice(2);
const hasFlag = (flag: string) => argv.includes(flag) || argv.includes(flag.startsWith("--") ? flag : `--${flag}`);
const getArg = (flag: string) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] ?? "" : "";
};

const shouldRun = hasFlag("run");
const casesPath = resolve(getArg("--cases") || DEFAULT_CASES);
const outPath = resolve(getArg("--out") || DEFAULT_OUT);
const extraArgs = getArg("--extra-args");

const DEFAULT_GATE: Required<RepeatabilityBenchmarkGate> = {
  require_benchmark: true,
  require_warm_cache_hit: true,
  allowed_warm_sources: ["route-cache", "marketplace"],
  disallowed_warm_sources: ["live-capture"],
  max_warm_total_ms: 20_000,
  max_warm_rounds: 2,
  max_warm_cold_ratio: 1.2,
  max_warm_slowdown_ms: 1_500,
  min_speedup_ms: 0,
};

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function runHarness(): void {
  if (existsSync(outPath)) {
    try { unlinkSync(outPath); } catch { /* best effort */ }
  }
  const args = [
    "evals/codex-autonomous-harness.ts",
    "--benchmark",
    "--cases",
    casesPath,
    "--out",
    outPath,
  ];
  if (extraArgs) {
    args.push(...extraArgs.split(" ").filter(Boolean));
  }
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      UNBROWSE_FORCE_CAPTURE: process.env.UNBROWSE_FORCE_CAPTURE ?? "0",
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (!existsSync(outPath)) {
    throw new Error(`[repeatability-gate] harness did not produce ${outPath}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    console.warn(`[repeatability-gate] harness exited with status ${result.status}; evaluating partial output if present.`);
  }
}

export function loadGateConfig(path: string): Map<string, Required<RepeatabilityBenchmarkGate>> {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as RawSuite;
  const defaults = {
    ...DEFAULT_GATE,
    ...(raw.meta?.benchmark_gate_defaults ?? {}),
  };
  const map = new Map<string, Required<RepeatabilityBenchmarkGate>>();
  for (const testCase of raw.cases ?? []) {
    map.set(testCase.id, {
      ...defaults,
      ...(testCase.benchmark_gate ?? {}),
      allowed_warm_sources: testCase.benchmark_gate?.allowed_warm_sources ?? defaults.allowed_warm_sources,
      disallowed_warm_sources: testCase.benchmark_gate?.disallowed_warm_sources ?? defaults.disallowed_warm_sources,
    });
  }
  return map;
}

export function evaluateRepeatabilityGate(
  result: AutonomousResult,
  gate?: RepeatabilityBenchmarkGate,
): GateEvaluation {
  const resolvedGate = {
    ...DEFAULT_GATE,
    ...(gate ?? {}),
    allowed_warm_sources: gate?.allowed_warm_sources ?? DEFAULT_GATE.allowed_warm_sources,
    disallowed_warm_sources: gate?.disallowed_warm_sources ?? DEFAULT_GATE.disallowed_warm_sources,
  };
  const failures: GateFailure[] = [];

  if (resolvedGate.require_benchmark && !result.benchmark) {
    failures.push({ code: "missing_benchmark", detail: "result has no cold/warm benchmark block" });
    return { ok: false, failures, warm_sources: [], warm_cache_hit: false };
  }

  const benchmark = result.benchmark;
  if (!benchmark) {
    return { ok: failures.length === 0, failures, warm_sources: [], warm_cache_hit: false };
  }

  const warmRounds = result.rounds.filter((round) => round.run_label === "warm");
  const warmSources = uniqueStrings(warmRounds.map((round) => round.trace_context?.source));
  const warmCacheHit = warmRounds.some((round) => round.trace_context?.cache_hit === true);
  const warmTotalMs = benchmark.warm.total_ms;
  const coldTotalMs = benchmark.cold.total_ms;

  if (!benchmark.warm.goal_satisfied) {
    failures.push({ code: "warm_unsatisfied", detail: benchmark.warm.final_reason });
  }
  if (resolvedGate.require_warm_cache_hit && !warmCacheHit) {
    failures.push({ code: "warm_cache_miss", detail: "warm run never reported timing.cache_hit=true" });
  }
  if (resolvedGate.allowed_warm_sources.length > 0 && !warmSources.some((source) => resolvedGate.allowed_warm_sources.includes(source))) {
    failures.push({
      code: "warm_source_missing",
      detail: `warm sources ${warmSources.join(",") || "none"} missing any of ${resolvedGate.allowed_warm_sources.join(",")}`,
    });
  }
  const blockedWarmSources = warmSources.filter((source) => resolvedGate.disallowed_warm_sources.includes(source));
  if (blockedWarmSources.length > 0) {
    failures.push({
      code: "warm_source_blocked",
      detail: `warm run used blocked source(s): ${blockedWarmSources.join(",")}`,
    });
  }
  if (warmTotalMs > resolvedGate.max_warm_total_ms) {
    failures.push({
      code: "warm_too_slow",
      detail: `${warmTotalMs}ms > ${resolvedGate.max_warm_total_ms}ms`,
    });
  }
  if (benchmark.warm.total_rounds > resolvedGate.max_warm_rounds) {
    failures.push({
      code: "warm_round_budget",
      detail: `${benchmark.warm.total_rounds} rounds > ${resolvedGate.max_warm_rounds}`,
    });
  }
  if (coldTotalMs > 0) {
    const warmColdRatio = warmTotalMs / coldTotalMs;
    if (warmColdRatio > resolvedGate.max_warm_cold_ratio) {
      failures.push({
        code: "warm_cold_ratio",
        detail: `${warmColdRatio.toFixed(2)}x > ${resolvedGate.max_warm_cold_ratio.toFixed(2)}x`,
      });
    }
  }
  const slowdownMs = warmTotalMs - coldTotalMs;
  if (slowdownMs > resolvedGate.max_warm_slowdown_ms) {
    failures.push({
      code: "warm_slowdown",
      detail: `${slowdownMs}ms > ${resolvedGate.max_warm_slowdown_ms}ms`,
    });
  }
  if (benchmark.delta.speedup_ms < resolvedGate.min_speedup_ms) {
    failures.push({
      code: "speedup_floor",
      detail: `${benchmark.delta.speedup_ms}ms < ${resolvedGate.min_speedup_ms}ms`,
    });
  }

  return {
    ok: failures.length === 0,
    failures,
    warm_sources: warmSources,
    warm_cache_hit: warmCacheHit,
    warm_total_ms: warmTotalMs,
    cold_total_ms: coldTotalMs,
  };
}

export function evaluatePayloadAgainstConfig(
  payload: ResultsPayload,
  configById: Map<string, Required<RepeatabilityBenchmarkGate>>,
): Array<{ result: AutonomousResult; evaluation: GateEvaluation }> {
  return payload.results.map((result) => ({
    result,
    evaluation: evaluateRepeatabilityGate(result, configById.get(result.id)),
  }));
}

function main(): void {
  if (shouldRun) runHarness();

  const payload = JSON.parse(readFileSync(outPath, "utf-8")) as ResultsPayload;
  const configById = loadGateConfig(casesPath);
  const evaluations = evaluatePayloadAgainstConfig(payload, configById);
  const failures = evaluations.filter((entry) => !entry.evaluation.ok);

  for (const entry of evaluations) {
    const warmInfo = entry.evaluation.warm_total_ms != null
      ? `cold=${entry.evaluation.cold_total_ms}ms warm=${entry.evaluation.warm_total_ms}ms sources=${entry.evaluation.warm_sources.join(",") || "none"} cache_hit=${entry.evaluation.warm_cache_hit}`
      : "no benchmark";
    if (entry.evaluation.ok) {
      console.log(`[repeatability-gate] PASS ${entry.result.id} ${warmInfo}`);
      continue;
    }
    console.log(`[repeatability-gate] FAIL ${entry.result.id} ${warmInfo}`);
    for (const failure of entry.evaluation.failures) {
      console.log(`  - ${failure.code}: ${failure.detail}`);
    }
  }

  console.log(`[repeatability-gate] ${evaluations.length - failures.length}/${evaluations.length} cases passed`);
  process.exit(failures.length === 0 ? 0 : 1);
}

if (import.meta.main) {
  main();
}
