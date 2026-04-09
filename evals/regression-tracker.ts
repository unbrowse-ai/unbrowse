/**
 * Regression tracker — archives eval runs and detects capability regressions over time.
 *
 * Storage: evals/history/{harness}.jsonl — one JSON line per run, append-only.
 *
 * Usage:
 *   bun evals/regression-tracker.ts                              # regressions from latest
 *   bun evals/regression-tracker.ts --trends                     # per-case sparkline
 *   bun evals/regression-tracker.ts --trends --case github-search
 *   bun evals/regression-tracker.ts --summary                    # pass-rate over time
 *   bun evals/regression-tracker.ts --harness autonomous         # switch harness
 *   bun evals/regression-tracker.ts --archive-last               # retroactively archive a last-run file
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";

const EVALS_DIR = dirname(new URL(import.meta.url).pathname);
const HISTORY_DIR = join(EVALS_DIR, "history");
const DEFAULT_HARNESS = "codex";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CaseSnapshot {
  status: "pass" | "fail" | "skip" | "blocked";
  ms?: number;
  reason?: string;
}

export interface RunRecord {
  ts: string;
  sha: string;
  branch: string;
  version: string;
  harness: string;
  summary: {
    total: number;
    pass: number;
    fail: number;
    skip: number;
    [key: string]: unknown;
  };
  cases: Record<string, CaseSnapshot>;
}

export interface Regression {
  case_id: string;
  was: "pass" | "fail" | "skip" | "blocked";
  now: "pass" | "fail" | "skip" | "blocked";
  previous_sha: string;
  current_sha: string;
  reason?: string;
}

// ── Git / version helpers ────────────────────────────────────────────────────

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8", cwd: join(EVALS_DIR, "..") }).trim();
  } catch {
    return "unknown";
  }
}

function gitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8", cwd: join(EVALS_DIR, "..") }).trim();
  } catch {
    return "unknown";
  }
}

function projectVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(EVALS_DIR, "../package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ── History I/O ──────────────────────────────────────────────────────────────

function historyPath(harness: string): string {
  return join(HISTORY_DIR, `${harness}.jsonl`);
}

function ensureHistoryDir(): void {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
}

export function appendRun(record: RunRecord): void {
  ensureHistoryDir();
  appendFileSync(historyPath(record.harness), JSON.stringify(record) + "\n");
}

export function loadHistory(harness: string): RunRecord[] {
  const path = historyPath(harness);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ── Archive from harness output ──────────────────────────────────────────────

/** Archive a codex-harness result (the full JSON written to codex-harness-last-run.json). */
export function archiveCodexRun(fullResult: any): RunRecord {
  const cases: Record<string, CaseSnapshot> = {};

  // Graph selection results — most objective per-case signal
  if (fullResult.graph?.selection_results) {
    for (const sel of fullResult.graph.selection_results) {
      cases[sel.id] = {
        status: sel.pass ? "pass" : "fail",
        reason: sel.pass ? undefined : `selected=${sel.selected} expected=${sel.expected}`,
      };
    }
  }

  // Overlay with full case results when present
  if (fullResult.results) {
    for (const r of fullResult.results) {
      const existing = cases[r.id];
      cases[r.id] = {
        status:
          r.agent_verdict && r.agent_verdict !== "skip"
            ? r.agent_verdict
            : existing?.status ?? (r.collector_status === "fail" ? "fail" : "skip"),
        ms: r.resolve_ms,
        reason: r.collector_reason ?? existing?.reason,
      };
    }
  }

  // Derive summary from normalized cases, not raw harness summary
  const caseList = Object.values(cases);
  const record: RunRecord = {
    ts: new Date().toISOString(),
    sha: gitSha(),
    branch: gitBranch(),
    version: projectVersion(),
    harness: "codex",
    summary: {
      total: caseList.length,
      pass: caseList.filter((c) => c.status === "pass").length,
      fail: caseList.filter((c) => c.status === "fail").length,
      skip: caseList.filter((c) => c.status === "skip").length,
      graph_hit_rate: fullResult.graph?.selection_summary?.hit_rate,
    },
    cases,
  };

  appendRun(record);
  return record;
}

/** Archive an autonomous-harness result. */
export function archiveAutonomousRun(fullResult: any): RunRecord {
  const cases: Record<string, CaseSnapshot> = {};

  if (fullResult.results) {
    for (const r of fullResult.results) {
      const totalMs = r.rounds?.reduce(
        (sum: number, round: any) => sum + (round.duration_ms ?? 0),
        0,
      );
      cases[r.id] = {
        status: r.final_state ?? "skip",
        ms: totalMs || undefined,
        reason: r.final_reason,
      };
    }
  }

  const summary = fullResult.summary ?? {};
  const record: RunRecord = {
    ts: new Date().toISOString(),
    sha: gitSha(),
    branch: gitBranch(),
    version: projectVersion(),
    harness: "autonomous",
    summary: {
      total: summary.total ?? 0,
      pass: summary.pass ?? 0,
      fail: summary.fail ?? 0,
      skip: summary.skip ?? 0,
      blocked: summary.blocked ?? 0,
      satisfied: summary.satisfied ?? 0,
    },
    cases,
  };

  appendRun(record);
  return record;
}

// ── Regression detection ─────────────────────────────────────────────────────

export function detectRegressions(harness: string): {
  regressions: Regression[];
  improvements: Regression[];
} {
  const history = loadHistory(harness);
  if (history.length < 2) return { regressions: [], improvements: [] };

  const current = history[history.length - 1];
  const previous = history[history.length - 2];

  const regressions: Regression[] = [];
  const improvements: Regression[] = [];

  for (const [caseId, snap] of Object.entries(current.cases)) {
    const prev = previous.cases[caseId];
    if (!prev) continue; // new case — can't regress

    if (prev.status === "pass" && snap.status !== "pass") {
      regressions.push({
        case_id: caseId,
        was: prev.status,
        now: snap.status,
        previous_sha: previous.sha,
        current_sha: current.sha,
        reason: snap.reason,
      });
    } else if (prev.status !== "pass" && snap.status === "pass") {
      improvements.push({
        case_id: caseId,
        was: prev.status,
        now: snap.status,
        previous_sha: previous.sha,
        current_sha: current.sha,
      });
    }
  }

  // Cases that existed before but are missing now
  for (const caseId of Object.keys(previous.cases)) {
    if (!(caseId in current.cases)) {
      regressions.push({
        case_id: caseId,
        was: previous.cases[caseId].status,
        now: "skip",
        previous_sha: previous.sha,
        current_sha: current.sha,
        reason: "case dropped from run",
      });
    }
  }

  return { regressions, improvements };
}

// ── Trend view ───────────────────────────────────────────────────────────────

export function caseTrends(
  harness: string,
  lastN = 20,
): Map<string, { status: string; sha: string; ts: string }[]> {
  const history = loadHistory(harness).slice(-lastN);
  const trends = new Map<string, { status: string; sha: string; ts: string }[]>();

  for (const run of history) {
    for (const [caseId, snap] of Object.entries(run.cases)) {
      if (!trends.has(caseId)) trends.set(caseId, []);
      trends.get(caseId)!.push({ status: snap.status, sha: run.sha, ts: run.ts });
    }
  }

  return trends;
}

function statusChar(s: string): string {
  switch (s) {
    case "pass":
      return "\x1b[32m✓\x1b[0m";
    case "fail":
      return "\x1b[31m✗\x1b[0m";
    case "skip":
      return "\x1b[33m-\x1b[0m";
    case "blocked":
      return "\x1b[35m⊘\x1b[0m";
    default:
      return "?";
  }
}

// ── Summary over time ────────────────────────────────────────────────────────

function printSummary(harness: string, lastN = 20): void {
  const history = loadHistory(harness).slice(-lastN);
  if (history.length === 0) {
    console.log("No history found.");
    return;
  }

  console.log(`\n  ${harness} harness — ${history.length} runs\n`);
  console.log("  Date                 SHA      Branch                   Pass  Fail  Skip  Total  Rate");
  console.log("  " + "─".repeat(88));

  for (const run of history) {
    const date = run.ts.replace("T", " ").slice(0, 19);
    const rate =
      run.summary.total > 0
        ? ((run.summary.pass / run.summary.total) * 100).toFixed(0) + "%"
        : "N/A";
    const branch = run.branch.length > 22 ? run.branch.slice(0, 22) + "…" : run.branch;
    console.log(
      `  ${date}  ${run.sha.padEnd(8)} ${branch.padEnd(24)} ${String(run.summary.pass).padStart(4)}  ${String(run.summary.fail).padStart(4)}  ${String(run.summary.skip).padStart(4)}  ${String(run.summary.total).padStart(5)}  ${rate.padStart(4)}`,
    );
  }
  console.log();
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  Regression Tracker — detect capability regressions across eval runs

  Commands:
    (default)           Show regressions between last two runs
    --trends            Per-case pass/fail sparkline
    --trends --case ID  Filter to one case
    --summary           Pass-rate table over time
    --archive-last      Archive current *-last-run.json into history

  Options:
    --harness NAME      codex (default) or autonomous
    --file PATH         Override last-run file path for --archive-last
`);
    process.exit(0);
  }

  const harness = args.includes("--harness")
    ? args[args.indexOf("--harness") + 1]
    : DEFAULT_HARNESS;

  // Archive mode — retroactively ingest a last-run file
  if (args.includes("--archive-last")) {
    const defaultFile =
      harness === "autonomous"
        ? "codex-autonomous-last-run.json"
        : "codex-harness-last-run.json";
    const lastRunPath = args.includes("--file")
      ? args[args.indexOf("--file") + 1]
      : join(EVALS_DIR, defaultFile);

    if (!existsSync(lastRunPath)) {
      console.error(`No results file at ${lastRunPath}`);
      process.exit(1);
    }

    const data = JSON.parse(readFileSync(lastRunPath, "utf-8"));
    const record =
      harness === "autonomous" ? archiveAutonomousRun(data) : archiveCodexRun(data);
    console.log(
      `Archived ${Object.keys(record.cases).length} cases from ${record.sha} (${record.harness})`,
    );
  }

  // Regression detection (default mode)
  if (args.includes("--regressions") || (!args.includes("--trends") && !args.includes("--summary") && !args.includes("--archive-last"))) {
    const { regressions, improvements } = detectRegressions(harness);

    if (regressions.length === 0 && improvements.length === 0) {
      const history = loadHistory(harness);
      if (history.length < 2) {
        console.log(
          `\n  Need ≥2 runs to detect regressions (have ${history.length}).`,
        );
        console.log(
          `  Archive existing results: bun evals/regression-tracker.ts --archive-last\n`,
        );
      } else {
        console.log("\n  No regressions or improvements detected.\n");
      }
    } else {
      if (regressions.length > 0) {
        console.log(`\n  \x1b[31m${regressions.length} REGRESSION(S)\x1b[0m\n`);
        for (const r of regressions) {
          console.log(
            `    ${r.case_id}: ${r.was} → ${r.now}  (${r.previous_sha}→${r.current_sha})${r.reason ? `  — ${r.reason}` : ""}`,
          );
        }
      }
      if (improvements.length > 0) {
        console.log(
          `\n  \x1b[32m${improvements.length} IMPROVEMENT(S)\x1b[0m\n`,
        );
        for (const r of improvements) {
          console.log(
            `    ${r.case_id}: ${r.was} → ${r.now}  (${r.previous_sha}→${r.current_sha})`,
          );
        }
      }
      console.log();
    }
  }

  // Trend sparklines
  if (args.includes("--trends")) {
    const filterCase = args.includes("--case")
      ? args[args.indexOf("--case") + 1]
      : undefined;
    const trends = caseTrends(harness);

    console.log(`\n  ${harness} — capability trends (last 20 runs)\n`);
    console.log("  ✓=pass  ✗=fail  -=skip  ⊘=blocked\n");

    for (const [caseId, entries] of [...trends.entries()].sort()) {
      if (filterCase && caseId !== filterCase) continue;
      const sparkline = entries.map((e) => statusChar(e.status)).join("");
      const latest = entries[entries.length - 1];
      console.log(`  ${caseId.padEnd(40)} ${sparkline}  [${latest.status}]`);
    }
    console.log();
  }

  // Summary table
  if (args.includes("--summary")) {
    printSummary(harness);
  }
}
