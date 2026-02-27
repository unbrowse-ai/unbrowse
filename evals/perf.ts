#!/usr/bin/env bun
/**
 * Unbrowse performance eval harness.
 *
 * Runs benchmark suite against live endpoints, compares to baseline,
 * logs history, and exits non-zero on regression.
 *
 * Usage:
 *   bun evals/perf.ts                  # run eval, compare to baseline
 *   bun evals/perf.ts --update-baseline  # rewrite baseline with current results
 *   bun evals/perf.ts --skip-server      # assume server is already running
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";

const EVALS_DIR = dirname(new URL(import.meta.url).pathname);
const SUITE_PATH = join(EVALS_DIR, "suite.json");
const BASELINE_PATH = join(EVALS_DIR, "baseline.json");
const HISTORY_PATH = join(EVALS_DIR, "history.jsonl");
const UNBROWSE = process.env.UNBROWSE_URL ?? "http://localhost:6969";

const args = new Set(process.argv.slice(2));
const updateBaseline = args.has("--update-baseline");
const skipServer = args.has("--skip-server");

// --- Types ---

interface BenchEntry {
  name: string;
  mode: "execute" | "resolve";
  skill_id?: string;
  endpoint_id?: string;
  intent?: string;
  url?: string;
  params: Record<string, unknown>;
  runs: number;
}

interface BaselineEntry {
  p50_ms: number;
  threshold_multiplier: number;
}

interface RunResult {
  name: string;
  p50_ms: number;
  runs_ms: number[];
  baseline_ms: number | null;
  threshold_ms: number | null;
  pass: boolean;
  error?: string;
}

// --- Helpers ---

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

async function ensureServer(): Promise<boolean> {
  try {
    const res = await fetch(`${UNBROWSE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function benchExecute(entry: BenchEntry): Promise<number> {
  const start = performance.now();
  const res = await fetch(`${UNBROWSE}/v1/skills/${entry.skill_id}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: { endpoint_id: entry.endpoint_id, ...entry.params },
    }),
  });
  await res.json(); // consume body
  return performance.now() - start;
}

async function benchResolve(entry: BenchEntry): Promise<number> {
  const start = performance.now();
  const res = await fetch(`${UNBROWSE}/v1/intent/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: entry.intent,
      params: { url: entry.url, ...entry.params },
      context: { url: entry.url },
    }),
  });
  await res.json();
  return performance.now() - start;
}

async function runBench(entry: BenchEntry): Promise<RunResult> {
  const timings: number[] = [];
  let error: string | undefined;

  for (let i = 0; i < entry.runs; i++) {
    try {
      const ms = entry.mode === "execute"
        ? await benchExecute(entry)
        : await benchResolve(entry);
      timings.push(Math.round(ms));
    } catch (err) {
      error = String(err);
      timings.push(-1);
    }
  }

  const valid = timings.filter((t) => t > 0);
  const p50 = valid.length > 0 ? Math.round(median(valid)) : -1;

  return {
    name: entry.name,
    p50_ms: p50,
    runs_ms: timings,
    baseline_ms: null,
    threshold_ms: null,
    pass: true,
    error,
  };
}

// --- Main ---

async function main() {
  // Load suite
  const suite: BenchEntry[] = JSON.parse(readFileSync(SUITE_PATH, "utf-8"));

  // Check server
  if (!skipServer) {
    const alive = await ensureServer();
    if (!alive) {
      console.error(`unbrowse server not reachable at ${UNBROWSE}`);
      console.error("Start it with: cd ~/.agents/skills/unbrowse && UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 bun src/index.ts");
      process.exit(1);
    }
  }

  // Load baseline (may not exist yet)
  let baseline: Record<string, BaselineEntry> = {};
  if (existsSync(BASELINE_PATH)) {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  }

  const sha = gitSha();
  const ts = new Date().toISOString();

  console.log(`\nunbrowse eval \u2014 ${ts} (${sha})`);
  console.log("\u2500".repeat(58));

  // Run benchmarks
  const results: RunResult[] = [];
  for (const entry of suite) {
    const result = await runBench(entry);

    // Compare to baseline
    const bl = baseline[entry.name];
    if (bl && result.p50_ms > 0) {
      result.baseline_ms = bl.p50_ms;
      result.threshold_ms = Math.round(bl.p50_ms * bl.threshold_multiplier);
      result.pass = result.p50_ms <= result.threshold_ms;
    }

    results.push(result);

    // Print row
    const nameCol = result.name.padEnd(32);
    const msCol = result.p50_ms > 0 ? `${result.p50_ms}ms`.padStart(8) : "  ERROR".padStart(8);
    const blCol = result.baseline_ms ? `(baseline: ${result.baseline_ms}ms)` : "(no baseline)";
    const status = result.error
      ? "\x1b[31mERROR\x1b[0m"
      : result.pass
        ? "\x1b[32mOK\x1b[0m"
        : `\x1b[31mFAIL (${(result.p50_ms / result.baseline_ms!).toFixed(1)}x > ${(result.threshold_ms! / result.baseline_ms!).toFixed(1)}x limit)\x1b[0m`;

    console.log(`  ${nameCol} ${msCol}  ${blCol}  ${status}`);
  }

  console.log("\u2500".repeat(58));

  // Write history
  const historyEntry = {
    ts,
    sha,
    results: Object.fromEntries(
      results.map((r) => [r.name, { p50_ms: r.p50_ms, runs: r.runs_ms }])
    ),
  };
  appendFileSync(HISTORY_PATH, JSON.stringify(historyEntry) + "\n");

  // Update baseline mode
  if (updateBaseline) {
    const newBaseline: Record<string, BaselineEntry> = {};
    for (const r of results) {
      if (r.p50_ms > 0) {
        const existing = baseline[r.name];
        newBaseline[r.name] = {
          p50_ms: r.p50_ms,
          threshold_multiplier: existing?.threshold_multiplier ?? 2.5,
        };
      }
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + "\n");
    console.log(`Baseline updated with ${Object.keys(newBaseline).length} entries.`);
    process.exit(0);
  }

  // Check for failures
  const failures = results.filter((r) => !r.pass);
  const errors = results.filter((r) => !!r.error);

  if (failures.length > 0) {
    console.log(`\x1b[31mBLOCKED: ${failures.length} endpoint(s) exceeded threshold.\x1b[0m`);
    console.log("Run `bun evals/perf.ts --update-baseline` if this is intentional.");
    process.exit(1);
  }

  if (errors.length > 0) {
    console.log(`\x1b[33mWARNING: ${errors.length} endpoint(s) errored but not blocking.\x1b[0m`);
  }

  console.log(`All ${results.length} endpoint(s) within threshold. Commit allowed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Eval harness failed:", err);
  process.exit(1);
});
