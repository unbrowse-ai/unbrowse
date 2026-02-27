#!/usr/bin/env bun
/**
 * Unbrowse eval harness — tests the whole pipeline.
 *
 * Three test modes:
 *   execute  — hit a cached skill endpoint (fast, tests execution engine)
 *   resolve  — marketplace lookup + execute (tests ranking + caching)
 *   retrieve — full pipeline: intent → discover → extract → return data
 *              (tests live capture, endpoint selection, DOM/API extraction)
 *
 * Usage:
 *   bun evals/perf.ts                    # pre-commit: fast tests only (execute + resolve)
 *   bun evals/perf.ts --full             # all tests including retrieval, with data summaries
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
const LAST_RUN_PATH = join(EVALS_DIR, "last-run.json");
const UNBROWSE = process.env.UNBROWSE_URL ?? "http://localhost:6969";

const args = new Set(process.argv.slice(2));
const updateBaseline = args.has("--update-baseline");
const skipServer = args.has("--skip-server");
const fullMode = args.has("--full");

// --- Types ---

interface BenchEntry {
  name: string;
  mode: "execute" | "resolve" | "retrieve";
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
  mode: string;
  p50_ms: number;
  runs_ms: number[];
  baseline_ms: number | null;
  threshold_ms: number | null;
  perf_pass: boolean;
  error?: string;
  data_summary: string;
  data_snapshot: unknown;
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

/** Produce a human-readable summary of the full response */
function summarizeData(body: Record<string, unknown>, mode: string): { summary: string; snapshot: unknown } {
  const trace = body.trace as Record<string, unknown> | undefined;
  const result = body.result as unknown;
  const source = body.source as string | undefined;
  const skill = body.skill as Record<string, unknown> | undefined;

  const parts: string[] = [];

  // Pipeline metadata
  if (source) parts.push(`source=${source}`);
  if (trace?.status_code) parts.push(`status=${trace.status_code}`);
  else if (trace?.success === false) parts.push(`FAILED${trace.error ? ": " + String(trace.error).slice(0, 60) : ""}`);

  // Discovery info (for resolve/retrieve)
  if (skill) {
    const eps = skill.endpoints as unknown[];
    if (eps) parts.push(`endpoints=${eps.length}`);
    if (skill.domain) parts.push(`domain=${skill.domain}`);
  }

  // Extraction info
  let data: unknown = result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (r._extraction) {
      const ext = r._extraction as Record<string, unknown>;
      parts.push(`extraction=${ext.method}`);
      data = r.data;
    }
    if (r.error) {
      parts.push(`error=${r.error}`);
      if (r.message) parts.push(String(r.message).slice(0, 80));
    }
    // Resolve returns hint/message when it can't auto-select
    if (r.hint) parts.push("needs_endpoint_selection");
  }

  // Data shape
  if (Array.isArray(data)) {
    parts.push(`array[${data.length}]`);
    if (data.length > 0 && typeof data[0] === "object" && data[0] != null) {
      parts.push(`fields=[${Object.keys(data[0] as object).slice(0, 6).join(",")}]`);
    }
  } else if (data && typeof data === "object" && !(data as Record<string, unknown>).error) {
    const keys = Object.keys(data as object);
    parts.push(`object{${keys.slice(0, 6).join(",")}}`);
  } else if (typeof data === "string") {
    if (data.startsWith("<!")) parts.push("RAW_HTML");
    else parts.push(`string(${data.length})`);
  }

  // Build snapshot
  let snapshot: unknown;
  if (mode === "retrieve" || mode === "resolve") {
    // For pipeline tests, include discovery metadata + data sample
    const meta: Record<string, unknown> = {};
    if (source) meta.source = source;
    if (skill) {
      meta.skill_id = skill.skill_id;
      meta.domain = skill.domain;
      meta.endpoint_count = (skill.endpoints as unknown[])?.length;
      meta.endpoints = ((skill.endpoints as Array<Record<string, unknown>>) || []).slice(0, 5).map(ep => ({
        method: ep.method,
        url: (ep.url_template as string)?.slice(0, 80),
        id: ep.endpoint_id,
      }));
    }
    if (trace?.error) meta.error = trace.error;
    // Data sample
    if (Array.isArray(data)) {
      meta.data_sample = data.slice(0, 2);
    } else if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      const truncated: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj).slice(0, 8)) {
        if (Array.isArray(v)) truncated[k] = `[${v.length} items]`;
        else if (typeof v === "string" && v.length > 150) truncated[k] = v.slice(0, 150) + "...";
        else truncated[k] = v;
      }
      meta.data_sample = truncated;
    }
    snapshot = meta;
  } else {
    // For execute tests, just show data
    if (Array.isArray(data)) {
      snapshot = data.slice(0, 2);
    } else if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      const truncated: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj).slice(0, 10)) {
        if (Array.isArray(v)) truncated[k] = `[${v.length} items]`;
        else if (typeof v === "string" && v.length > 200) truncated[k] = v.slice(0, 200) + "...";
        else truncated[k] = v;
      }
      snapshot = truncated;
    } else {
      snapshot = typeof data === "string" ? data.slice(0, 300) : data;
    }
  }

  return { summary: parts.join(" | "), snapshot };
}

// --- Bench functions ---

interface BenchResult {
  ms: number;
  body: Record<string, unknown>;
}

async function benchExecute(entry: BenchEntry): Promise<BenchResult> {
  const start = performance.now();
  const res = await fetch(`${UNBROWSE}/v1/skills/${entry.skill_id}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      params: { endpoint_id: entry.endpoint_id, ...entry.params },
    }),
  });
  const body = await res.json() as Record<string, unknown>;
  return { ms: performance.now() - start, body };
}

async function benchResolve(entry: BenchEntry): Promise<BenchResult> {
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
  const body = await res.json() as Record<string, unknown>;
  return { ms: performance.now() - start, body };
}

async function runBench(entry: BenchEntry): Promise<RunResult> {
  const timings: number[] = [];
  let lastBody: Record<string, unknown> = {};
  let error: string | undefined;

  // retrieve mode: only 1 run (it's slow + may do live capture)
  const runs = entry.mode === "retrieve" ? 1 : entry.runs;

  for (let i = 0; i < runs; i++) {
    try {
      const { ms, body } = entry.mode === "execute"
        ? await benchExecute(entry)
        : await benchResolve(entry); // resolve and retrieve both use intent/resolve
      timings.push(Math.round(ms));
      lastBody = body;
    } catch (err) {
      error = String(err);
      timings.push(-1);
    }
  }

  const valid = timings.filter((t) => t > 0);
  const p50 = valid.length > 0 ? Math.round(median(valid)) : -1;

  const { summary, snapshot } = Object.keys(lastBody).length > 0
    ? summarizeData(lastBody, entry.mode)
    : { summary: error ?? "no response", snapshot: null };

  return {
    name: entry.name,
    mode: entry.mode,
    p50_ms: p50,
    runs_ms: timings,
    baseline_ms: null,
    threshold_ms: null,
    perf_pass: true,
    error,
    data_summary: summary,
    data_snapshot: snapshot,
  };
}

// --- Main ---

async function main() {
  const allEntries: BenchEntry[] = JSON.parse(readFileSync(SUITE_PATH, "utf-8"));

  // Pre-commit (no --full): skip retrieve tests (slow, need browser)
  const suite = fullMode
    ? allEntries
    : allEntries.filter((e) => e.mode !== "retrieve");

  if (!skipServer) {
    const alive = await ensureServer();
    if (!alive) {
      console.error(`unbrowse server not reachable at ${UNBROWSE}`);
      console.error("Start it with: cd ~/.agents/skills/unbrowse && UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 bun src/index.ts");
      process.exit(1);
    }
  }

  let baseline: Record<string, BaselineEntry> = {};
  if (existsSync(BASELINE_PATH)) {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  }

  const sha = gitSha();
  const ts = new Date().toISOString();
  const skipped = allEntries.length - suite.length;

  console.log(`\nunbrowse eval \u2014 ${ts} (${sha})${skipped > 0 ? ` [${skipped} retrieve tests skipped, use --full]` : ""}`);
  console.log("\u2500".repeat(76));

  const results: RunResult[] = [];
  for (const entry of suite) {
    const result = await runBench(entry);

    // Perf baseline comparison (retrieve tests exempt — too variable)
    if (entry.mode !== "retrieve") {
      const bl = baseline[entry.name];
      if (bl && result.p50_ms > 0) {
        result.baseline_ms = bl.p50_ms;
        result.threshold_ms = Math.round(bl.p50_ms * bl.threshold_multiplier);
        result.perf_pass = result.p50_ms <= result.threshold_ms;
      }
    }

    results.push(result);

    // Print row
    const modeTag = entry.mode === "execute" ? "" : entry.mode === "resolve" ? " [r]" : " [R]";
    const nameCol = (result.name + modeTag).padEnd(32);
    const msCol = result.p50_ms > 0 ? `${result.p50_ms}ms`.padStart(8) : "  ERROR".padStart(8);
    const blCol = result.baseline_ms ? `(base: ${result.baseline_ms}ms)`.padEnd(16) : "(no baseline)   ";

    let status: string;
    if (result.error) {
      status = "\x1b[33mERROR\x1b[0m";
    } else if (!result.perf_pass) {
      status = `\x1b[31mSLOW ${(result.p50_ms / result.baseline_ms!).toFixed(1)}x\x1b[0m`;
    } else {
      status = "\x1b[32mPASS\x1b[0m";
    }

    console.log(`  ${nameCol} ${msCol}  ${blCol}  ${status}`);

    // Show data summary in full mode, or always for retrieve tests
    if (fullMode || entry.mode === "retrieve") {
      console.log(`    \x1b[36m${result.data_summary}\x1b[0m`);
    }
  }

  console.log("\u2500".repeat(76));

  // Write last-run.json
  const lastRun = {
    ts,
    sha,
    mode: fullMode ? "full" : "pre-commit",
    results: results.map((r) => ({
      name: r.name,
      mode: r.mode,
      p50_ms: r.p50_ms,
      perf_pass: r.perf_pass,
      data_summary: r.data_summary,
      data_snapshot: r.data_snapshot,
      error: r.error,
    })),
  };
  writeFileSync(LAST_RUN_PATH, JSON.stringify(lastRun, null, 2));

  // Write history
  const historyEntry = {
    ts,
    sha,
    results: Object.fromEntries(
      results.map((r) => [r.name, { p50_ms: r.p50_ms, runs: r.runs_ms, data: r.data_summary }])
    ),
  };
  appendFileSync(HISTORY_PATH, JSON.stringify(historyEntry) + "\n");

  // Update baseline (only for execute + resolve, not retrieve)
  if (updateBaseline) {
    const newBaseline: Record<string, BaselineEntry> = {};
    for (const r of results) {
      if (r.p50_ms > 0 && r.mode !== "retrieve") {
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

  // Block on perf regressions (execute + resolve only, not retrieve)
  const perfFails = results.filter((r) => !r.perf_pass && r.mode !== "retrieve");
  const errors = results.filter((r) => !!r.error);

  if (perfFails.length > 0) {
    console.log(`\x1b[31mBLOCKED: ${perfFails.length} perf regression(s).\x1b[0m`);
    console.log("Run `bun evals/perf.ts --update-baseline` if intentional.");
    process.exit(1);
  }

  if (errors.length > 0) {
    console.log(`\x1b[33m${errors.length} endpoint(s) errored (not blocking).\x1b[0m`);
  }

  console.log(`${results.length - errors.length}/${results.length} passed. Data in evals/last-run.json`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Eval harness failed:", err);
  process.exit(1);
});
