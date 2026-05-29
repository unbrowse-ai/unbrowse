#!/usr/bin/env bun
/**
 * scripts/matrix/run.ts — 3x2 thoroughness matrix orchestrator.
 *
 * Iterates the 6 cells declared in cells.json, sets per-column env, invokes
 * the per-row runner, parses summary.kv into a JSONL evidence row, and writes
 * results.jsonl + index.txt at the matrix root.
 *
 * Per CLAUDE.md (harness-collects-agent-judges): the orchestrator does NOT
 * stamp a green/red verdict. It collects per-cell sub_state + raw artifacts.
 * The agent reads results.jsonl in-thread and judges each cell against the
 * docs/benchmarks.md rubric philosophy + the user's "no fake green" rule.
 *
 * Smoke run mode (default): runs all 6 cells once, surfaces honest red where
 * the surface isn't reachable today, exits 0 regardless. The exit code of
 * THIS orchestrator is NOT a verdict — read results.jsonl.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..");
const MATRIX_DIR = join(ROOT, "scripts", "matrix");
const ARTIFACT_ROOT = join(MATRIX_DIR, ".artifacts");
const RESULTS_PATH = join(MATRIX_DIR, "results.jsonl");
const INDEX_PATH = join(MATRIX_DIR, "index.txt");

mkdirSync(ARTIFACT_ROOT, { recursive: true });

interface CellsJson {
  rows: Record<string, { surface: string; runner: string; doc?: string }>;
  columns: Record<string, { posture: string; env: Record<string, string>; expected_substate_on_paid_probe?: string[]; doc?: string }>;
  cells: Array<{ id: string; row: string; column: string }>;
}

const cells: CellsJson = JSON.parse(readFileSync(join(MATRIX_DIR, "cells.json"), "utf8"));

function resolveEnvInterpolation(value: string): string {
  // ${VAR:-default} or ${VAR}
  return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name, dflt) => {
    return process.env[name] ?? dflt ?? "";
  });
}

function runCell(cellId: string, row: string, column: string): Record<string, any> {
  const rowDef = cells.rows[row];
  const colDef = cells.columns[column];
  if (!rowDef || !colDef) {
    return { cell_id: cellId, row, column, sub_state: "harness_red", diagnostic: "row or column missing from cells.json", exit_code: 2, duration_ms: 0 };
  }
  const artDir = join(ARTIFACT_ROOT, cellId);
  mkdirSync(artDir, { recursive: true });

  // Build per-cell env: start with current env, then APPLY column env (empty
  // string in cells.json explicitly UNSETS the variable; that's how C2
  // clears UNBROWSE_WALLET_ADAPTER without ambiguity).
  const cellEnv = { ...process.env };
  for (const [k, v] of Object.entries(colDef.env)) {
    const resolved = resolveEnvInterpolation(v);
    if (resolved === "") {
      delete cellEnv[k];
    } else {
      cellEnv[k] = resolved;
    }
  }
  cellEnv.MATRIX_CELL_ID = cellId;
  cellEnv.MATRIX_ARTIFACT_DIR = artDir;
  cellEnv.MATRIX_ROW = row;
  cellEnv.MATRIX_COLUMN = column;

  const runnerPath = join(ROOT, rowDef.runner);
  const isShell = runnerPath.endsWith(".sh");
  const isBunTs = runnerPath.endsWith(".ts");

  let cmd: string;
  let args: string[];
  if (isShell) {
    cmd = "bash";
    args = [runnerPath];
  } else if (isBunTs) {
    cmd = "bun";
    args = ["run", runnerPath];
  } else {
    return { cell_id: cellId, row, column, sub_state: "harness_red", diagnostic: `unknown runner extension: ${runnerPath}`, exit_code: 2, duration_ms: 0 };
  }

  console.error(`[matrix] running ${cellId} (row=${row} column=${column}) ${cmd} ${args.join(" ")}`);
  const t0 = Date.now();
  const proc = spawnSync(cmd, args, { env: cellEnv, stdio: "inherit", cwd: ROOT });
  const dur = Date.now() - t0;

  // Parse summary.kv if present
  const summaryPath = join(artDir, "summary.kv");
  const summary: Record<string, string> = {};
  if (existsSync(summaryPath)) {
    const txt = readFileSync(summaryPath, "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m) summary[m[1]] = m[2];
    }
  }

  const row_evidence: Record<string, any> = {
    cell_id: cellId,
    row,
    column,
    column_env: {
      UNBROWSE_WALLET_ADAPTER_present: !!cellEnv.UNBROWSE_WALLET_ADAPTER,
      UNBROWSE_WALLET_KEY_present: !!cellEnv.UNBROWSE_WALLET_KEY,
    },
    exit_code: typeof summary.exit_code !== "undefined" ? Number(summary.exit_code) : (proc.status ?? 2),
    runner_exit: proc.status,
    duration_ms: typeof summary.duration_ms !== "undefined" ? Number(summary.duration_ms) : dur,
    raw_artifact_path: artDir.replace(ROOT + "/", ""),
    sub_state: summary.sub_state || "no_summary_emitted",
    diagnostic: summary.diagnostic || null,
    extra: summary,
    verdict_signal: "evidence_only_agent_judges",
    ts: new Date().toISOString(),
  };
  return row_evidence;
}

// -----------------------------------------------------------------------
// Reset results.jsonl + index.txt and run every cell.
// -----------------------------------------------------------------------
writeFileSync(RESULTS_PATH, "");
const evidenceRows: any[] = [];
for (const cell of cells.cells) {
  const row = runCell(cell.id, cell.row, cell.column);
  evidenceRows.push(row);
  // Append immediately so a crash leaves a partial-but-honest ledger.
  writeFileSync(RESULTS_PATH, evidenceRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// -----------------------------------------------------------------------
// index.txt — one human-readable line per cell. NO verdict; sub_state +
// http code or exit code only. Agent reads in-thread.
// -----------------------------------------------------------------------
const indexLines = evidenceRows.map((r) => {
  const extras: string[] = [];
  if (r.extra?.llm_http_code) extras.push(`llm_http=${r.extra.llm_http_code}`);
  if (r.extra?.version_http_code) extras.push(`version_http=${r.extra.version_http_code}`);
  if (r.extra?.pages_walked) extras.push(`pages=${r.extra.pages_walked}`);
  if (r.extra?.pages_with_errors) extras.push(`page_errors=${r.extra.pages_with_errors}`);
  return `${r.cell_id.padEnd(6)} row=${r.row} column=${r.column.padEnd(2)} exit=${String(r.exit_code).padEnd(3)} dur=${String(r.duration_ms).padEnd(7)}ms sub_state=${r.sub_state.padEnd(28)} ${extras.join(" ")}${r.diagnostic ? "  diag=" + r.diagnostic : ""}`;
});
writeFileSync(INDEX_PATH, indexLines.join("\n") + "\n");

console.error("\n========== MATRIX EVIDENCE (no verdict — agent judges) ==========");
for (const l of indexLines) console.error(l);
console.error("\nresults.jsonl:", RESULTS_PATH);
console.error("index.txt:    ", INDEX_PATH);
console.error("artifacts:    ", ARTIFACT_ROOT);
console.error("=================================================================\n");

// Exit 0: this orchestrator collected evidence. Cell-level red is in
// results.jsonl per the harness-collects-agent-judges rule.
process.exit(0);
