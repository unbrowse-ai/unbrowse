#!/usr/bin/env bun

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type ManyDomainsGate = {
  min_cases?: number;
  min_distinct_hosts?: number;
  min_distinct_intents?: number;
  min_satisfied_cases?: number;
  min_satisfied_ratio?: number;
  max_unsatisfied_cases?: number;
};

type RawCase = {
  id: string;
  intent: string;
  url: string;
};

type RawSuite = {
  meta?: {
    many_domains_gate_defaults?: ManyDomainsGate;
  };
  cases?: RawCase[];
};

type AutonomousResult = {
  id: string;
  final_state: "pass" | "fail" | "skip" | "blocked";
  goal_satisfied: boolean;
  final_reason: string;
};

type ResultsPayload = {
  summary?: {
    total?: number;
    pass?: number;
    fail?: number;
    skip?: number;
    blocked?: number;
    satisfied?: number;
    unsatisfied?: number;
  };
  results?: AutonomousResult[];
};

export type ManyDomainsFailure = {
  code: string;
  detail: string;
};

export type ManyDomainsEvaluation = {
  ok: boolean;
  failures: ManyDomainsFailure[];
  total_cases: number;
  distinct_hosts: number;
  distinct_intents: number;
  satisfied_cases: number;
  unsatisfied_cases: number;
  satisfied_ratio: number;
};

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_CASES = resolve(ROOT, "evals", "codex-cases.public-expansion.json");
const DEFAULT_OUT = resolve(ROOT, "evals", "codex-many-domains-last-run.json");
const DEFAULT_GATE: Required<ManyDomainsGate> = {
  min_cases: 12,
  min_distinct_hosts: 12,
  min_distinct_intents: 5,
  min_satisfied_cases: 8,
  min_satisfied_ratio: 0.55,
  max_unsatisfied_cases: 6,
};

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

function runHarness(): void {
  if (existsSync(outPath)) {
    try { unlinkSync(outPath); } catch { /* best effort */ }
  }
  const args = [
    "evals/codex-autonomous-harness.ts",
    "--cases",
    casesPath,
    "--out",
    outPath,
  ];
  if (extraArgs) args.push(...extraArgs.split(" ").filter(Boolean));
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
    throw new Error(`[many-domains-gate] harness did not produce ${outPath}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    console.warn(`[many-domains-gate] harness exited with status ${result.status}; evaluating partial output if present.`);
  }
}

function loadSuite(path: string): RawSuite {
  return JSON.parse(readFileSync(path, "utf-8")) as RawSuite;
}

function loadResults(path: string): ResultsPayload {
  return JSON.parse(readFileSync(path, "utf-8")) as ResultsPayload;
}

export function evaluateManyDomainsGate(
  suite: RawSuite,
  results: ResultsPayload,
  gate?: ManyDomainsGate,
): ManyDomainsEvaluation {
  const resolvedGate = { ...DEFAULT_GATE, ...(suite.meta?.many_domains_gate_defaults ?? {}), ...(gate ?? {}) };
  const failures: ManyDomainsFailure[] = [];

  const cases = suite.cases ?? [];
  const runs = results.results ?? [];
  const distinctHosts = new Set(cases.map((testCase) => new URL(testCase.url).hostname)).size;
  const distinctIntents = new Set(cases.map((testCase) => testCase.intent)).size;
  const satisfiedCases = runs.filter((result) => result.goal_satisfied).length;
  const unsatisfiedCases = runs.filter((result) => !result.goal_satisfied).length;
  const satisfiedRatio = cases.length > 0 ? satisfiedCases / cases.length : 0;

  if (cases.length < resolvedGate.min_cases) {
    failures.push({ code: "too_few_cases", detail: `${cases.length} < ${resolvedGate.min_cases}` });
  }
  if (distinctHosts < resolvedGate.min_distinct_hosts) {
    failures.push({ code: "too_few_hosts", detail: `${distinctHosts} < ${resolvedGate.min_distinct_hosts}` });
  }
  if (distinctIntents < resolvedGate.min_distinct_intents) {
    failures.push({ code: "too_few_intents", detail: `${distinctIntents} < ${resolvedGate.min_distinct_intents}` });
  }
  if (runs.length < cases.length) {
    failures.push({ code: "missing_results", detail: `${runs.length} result(s) for ${cases.length} case(s)` });
  }
  if (satisfiedCases < resolvedGate.min_satisfied_cases) {
    failures.push({ code: "satisfied_floor", detail: `${satisfiedCases} < ${resolvedGate.min_satisfied_cases}` });
  }
  if (satisfiedRatio < resolvedGate.min_satisfied_ratio) {
    failures.push({ code: "satisfied_ratio", detail: `${satisfiedRatio.toFixed(2)} < ${resolvedGate.min_satisfied_ratio.toFixed(2)}` });
  }
  if (unsatisfiedCases > resolvedGate.max_unsatisfied_cases) {
    failures.push({ code: "too_many_unsatisfied", detail: `${unsatisfiedCases} > ${resolvedGate.max_unsatisfied_cases}` });
  }

  return {
    ok: failures.length === 0,
    failures,
    total_cases: cases.length,
    distinct_hosts: distinctHosts,
    distinct_intents: distinctIntents,
    satisfied_cases: satisfiedCases,
    unsatisfied_cases: unsatisfiedCases,
    satisfied_ratio: satisfiedRatio,
  };
}

function main(): void {
  if (shouldRun) runHarness();
  const suite = loadSuite(casesPath);
  const results = loadResults(outPath);
  const evaluation = evaluateManyDomainsGate(suite, results);

  console.log(
    `[many-domains-gate] ${evaluation.satisfied_cases}/${evaluation.total_cases} satisfied`
    + ` hosts=${evaluation.distinct_hosts}`
    + ` intents=${evaluation.distinct_intents}`
    + ` ratio=${evaluation.satisfied_ratio.toFixed(2)}`,
  );

  for (const failure of evaluation.failures) {
    console.log(`[many-domains-gate] FAIL ${failure.code}: ${failure.detail}`);
  }

  if (!evaluation.ok) process.exitCode = 1;
}

if (import.meta.main) main();
