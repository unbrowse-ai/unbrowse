#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
};

type BenchmarkDelta = {
  speedup_ms: number;
  speedup_ratio?: number;
  token_delta: number;
  token_reduction_pct?: number;
};

type AutonomousResult = {
  id: string;
  intent: string;
  final_state: "pass" | "fail" | "skip" | "blocked";
  goal_satisfied: boolean;
  final_reason: string;
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
    benchmark_summary?: {
      cases: number;
      cold_total_ms: number;
      warm_total_ms: number;
      speedup_ms: number;
      token_delta: number;
    };
  };
  results: AutonomousResult[];
};

type RawCase = {
  id: string;
  retention_signal?: string;
  sticky_rationale?: string;
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

function stickyVerdict(result: AutonomousResult): string {
  const bench = result.benchmark;
  if (!bench) return result.goal_satisfied ? "pass-no-benchmark" : "failing";
  if (!bench.cold.goal_satisfied && !bench.warm.goal_satisfied) return "failing";
  if (!bench.cold.goal_satisfied && bench.warm.goal_satisfied) return "warm-only";
  if (bench.cold.goal_satisfied && !bench.warm.goal_satisfied) return "warm-regressed";
  if ((bench.delta.speedup_ms ?? 0) > 0 || (bench.delta.token_delta ?? 0) > 0) return "repeat-ready";
  return "repeat-pass";
}

function loadCaseMetadata(path: string): Map<string, RawCase> {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { cases?: RawCase[] };
  const map = new Map<string, RawCase>();
  for (const testCase of raw.cases ?? []) {
    map.set(testCase.id, testCase);
  }
  return map;
}

function runHarness(): void {
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
  const result = spawnSync("bun", args, {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      UNBROWSE_FORCE_CAPTURE: process.env.UNBROWSE_FORCE_CAPTURE ?? "0",
    },
  });
  if (typeof result.status === "number" && result.status !== 0) {
    console.warn(`[repeatability] harness exited with status ${result.status}; summarizing partial output if present.`);
  }
}

function formatRatio(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}x` : "—";
}

function main(): void {
  if (shouldRun) runHarness();

  const payload = JSON.parse(readFileSync(outPath, "utf-8")) as ResultsPayload;
  const metadata = loadCaseMetadata(casesPath);
  const benchmarked = payload.results.filter((result) => result.benchmark);

  const lines: string[] = [];
  lines.push("# Unbrowse Repeatability Report");
  lines.push("");
  lines.push(`Cases: ${payload.summary.total}`);
  lines.push(`Satisfied: ${payload.summary.satisfied}/${payload.summary.total}`);
  if (payload.summary.benchmark_summary) {
    const bench = payload.summary.benchmark_summary;
    lines.push(`Cold total: ${bench.cold_total_ms}ms`);
    lines.push(`Warm total: ${bench.warm_total_ms}ms`);
    lines.push(`Speedup: ${bench.speedup_ms}ms`);
    lines.push(`Token delta: ${bench.token_delta}`);
  }
  lines.push("");
  lines.push("## Case-by-case");
  lines.push("");
  lines.push("| Case | Verdict | Cold | Warm | Speedup | Token Delta | Retention Signal | Notes |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const result of benchmarked) {
    const bench = result.benchmark!;
    const meta = metadata.get(result.id);
    lines.push(
      `| ${result.id} | ${stickyVerdict(result)} | ${bench.cold.final_state}/${bench.cold.goal_satisfied ? "ok" : "no"} | ${bench.warm.final_state}/${bench.warm.goal_satisfied ? "ok" : "no"} | ${bench.delta.speedup_ms}ms (${formatRatio(bench.delta.speedup_ratio)}) | ${bench.delta.token_delta} | ${meta?.retention_signal ?? "—"} | ${meta?.sticky_rationale ?? result.final_reason} |`,
    );
  }

  const repeatReady = benchmarked.filter((result) => stickyVerdict(result) === "repeat-ready" || stickyVerdict(result) === "repeat-pass");
  const warmOnly = benchmarked.filter((result) => stickyVerdict(result) === "warm-only");
  const failing = benchmarked.filter((result) => stickyVerdict(result) === "failing" || stickyVerdict(result) === "warm-regressed");

  lines.push("");
  lines.push("## Readout");
  lines.push("");
  lines.push(`- Repeat-ready/pass: ${repeatReady.length}`);
  lines.push(`- Warm-only rescues: ${warmOnly.length}`);
  lines.push(`- Still failing/regressed: ${failing.length}`);
  lines.push("- Use this alongside auth and stress suites to decide whether repeat usage and warm-path reliability are improving.");

  console.log(lines.join("\n"));
}

main();
