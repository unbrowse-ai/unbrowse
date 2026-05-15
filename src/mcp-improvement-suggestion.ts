// AC5 : lane-07: improvement_suggestion enrichment.
//
// Reads ~/.claude/skills/unbrowse-improvement-loop/coverage.jsonl (override via
// UNBROWSE_COVERAGE_LEDGER_PATH) and builds an in-memory failure-mode -> ledger
// row map. NO hard-coded mapping: the ledger declares what each failure means.
//
// Falsifier: tests/mcp-execute-improvement-suggestion.test.ts.

import { readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CACHE_TTL_MS = 30_000; // R8: short TTL so freshly-shipped fixes surface.
const MAX_ROWS_SCAN = 50;     // upper bound per the AC5 prompt.

// Canonical failure codes the substrate maps to suggestions. Lifted directly
// from the AC5 prompt: NOT a hard-coded mapping (we still rely on ledger rows
// to declare named_regression + fix surface). This is the set of error_code
// values execute responses may carry that we should look up.
const CANONICAL_FAILURE_CODES = [
  "stale_endpoint",
  "endpoint_not_found",
  "payload_exceeded_wire_budget_after_diet",
  "4xx_live_session_fallback_no_session",
] as const;

type CanonicalFailureCode = (typeof CANONICAL_FAILURE_CODES)[number];

type CoverageRow = Record<string, unknown>;

type LookupEntry = {
  named_regression: string;
  candidate_fix_surface: string[];
};

type LookupTable = Map<string, LookupEntry>;

type CacheEntry = {
  loaded_at_ms: number;
  source_path: string;
  source_mtime_ms: number | null;
  table: LookupTable;
};

let cache: CacheEntry | null = null;

export function clearCoverageCache(): void {
  cache = null;
}

function defaultLedgerPath(): string {
  if (typeof process.env.UNBROWSE_COVERAGE_LEDGER_PATH === "string" && process.env.UNBROWSE_COVERAGE_LEDGER_PATH.length > 0) {
    return process.env.UNBROWSE_COVERAGE_LEDGER_PATH;
  }
  return path.join(os.homedir(), ".claude", "skills", "unbrowse-improvement-loop", "coverage.jsonl");
}

function readLedgerRows(ledgerPath: string): CoverageRow[] {
  if (!existsSync(ledgerPath)) return [];
  let content: string;
  try {
    content = readFileSync(ledgerPath, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const rows: CoverageRow[] = [];
  // Walk from newest (end of file) backwards, bounded by MAX_ROWS_SCAN.
  const start = Math.max(0, lines.length - MAX_ROWS_SCAN);
  for (let i = lines.length - 1; i >= start; i--) {
    try {
      const parsed = JSON.parse(lines[i] as string) as CoverageRow;
      rows.push(parsed);
    } catch {
      // skip malformed lines; ledger is append-only but we tolerate noise.
    }
  }
  return rows;
}

function rowNamedRegression(row: CoverageRow): string | undefined {
  // The ledger has heterogeneous field names across rows: prefer named_regression,
  // then regression. Lewis's notes call out the inconsistency in CLAUDE.md.
  const candidates = ["named_regression", "regression"] as const;
  for (const key of candidates) {
    const v = row[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function rowFiles(row: CoverageRow): string[] {
  // Files keys also vary: files_changed (jsonl rows from one wave), files
  // (rows from another wave), fix_file (single-file rows). Collect all.
  const out: string[] = [];
  for (const key of ["files_changed", "files"] as const) {
    const v = row[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.length > 0) out.push(item);
      }
    }
  }
  const fixFile = row.fix_file;
  if (typeof fixFile === "string" && fixFile.length > 0) out.push(fixFile);
  return out;
}

function filterToSourceSurfaces(files: string[]): string[] {
  // Drop CHANGELOG / test files / lockfiles: the agent's diagnose target is
  // the production source that carries the regression, not auxiliary files.
  // Keep src/ paths and explicit backend/ or packages/ source paths.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    if (f === "CHANGELOG.md") continue;
    if (f.startsWith("tests/") || f.includes("/tests/")) continue;
    if (f.endsWith(".test.ts") || f.endsWith(".test.sh")) continue;
    if (!f.startsWith("src/") && !f.startsWith("backend/src/") && !f.startsWith("packages/")) continue;
    if (seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

function buildLookupTable(rows: CoverageRow[]): LookupTable {
  const table: LookupTable = new Map();
  // Rows are pre-ordered newest-first. The first row containing a given
  // canonical code in its named_regression wins (most recent fix surface).
  for (const row of rows) {
    const named = rowNamedRegression(row);
    if (!named) continue;
    const files = filterToSourceSurfaces(rowFiles(row));
    if (files.length === 0) continue;
    for (const code of CANONICAL_FAILURE_CODES) {
      if (table.has(code)) continue;
      if (named.includes(code)) {
        table.set(code, { named_regression: named, candidate_fix_surface: files });
      }
    }
  }
  return table;
}

function getLookupTable(ledgerPath: string): LookupTable {
  const now = Date.now();
  if (cache && cache.source_path === ledgerPath && now - cache.loaded_at_ms < CACHE_TTL_MS) {
    // Honour mtime if available: stale-on-mtime-change cuts the worst case
    // when a fix ships inside the 30s window.
    let currentMtime: number | null = null;
    try {
      currentMtime = statSync(ledgerPath).mtimeMs;
    } catch {
      currentMtime = null;
    }
    if (currentMtime === cache.source_mtime_ms) {
      return cache.table;
    }
  }
  const rows = readLedgerRows(ledgerPath);
  const table = buildLookupTable(rows);
  let mtime: number | null = null;
  try {
    mtime = statSync(ledgerPath).mtimeMs;
  } catch {
    mtime = null;
  }
  cache = { loaded_at_ms: now, source_path: ledgerPath, source_mtime_ms: mtime, table };
  return table;
}

function extractFailureCode(response: Record<string, unknown>): string | undefined {
  // Execute response: error_code at root or under .error / .result.error_code.
  for (const key of ["error_code", "failure_mode"] as const) {
    const v = response[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const nested = response.error;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const v = (nested as Record<string, unknown>).code;
    if (typeof v === "string" && v.length > 0) return v;
  }
  const result = response.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const v = (result as Record<string, unknown>).error_code;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function shouldEnrich(response: Record<string, unknown>): boolean {
  // Reflect path: intent_status of failed/partial signals user intent didn't
  // resolve. The substrate uses this signal to surface fix surfaces.
  const intentStatus = response.intent_status;
  if (intentStatus === "failed" || intentStatus === "partial") return true;
  // Execute path: success === false AND a recognisable failure code present.
  if (response.success === false) return true;
  return false;
}

function buildSuggestion(failureCode: string, table: LookupTable): LookupEntry | null {
  // Direct match by canonical code key.
  if (table.has(failureCode)) return table.get(failureCode) ?? null;
  // Permissive fallback: any canonical code substring present in the caller's
  // failure code. e.g. "stale_endpoint_404" -> "stale_endpoint" match.
  for (const code of CANONICAL_FAILURE_CODES) {
    if (failureCode.includes(code) && table.has(code)) {
      return table.get(code) ?? null;
    }
  }
  return null;
}

export type ImprovementSuggestion = {
  named_regression: string;
  candidate_fix_surface: string[];
  next_action: { tool: "unbrowse_diagnose" | "none"; args: Record<string, unknown> };
};

export function enrichWithImprovementSuggestion(
  response: Record<string, unknown>,
  coverageLedgerPath?: string,
): Record<string, unknown> {
  if (!shouldEnrich(response)) return response;

  const ledgerPath = coverageLedgerPath ?? defaultLedgerPath();
  const table = getLookupTable(ledgerPath);

  const failureCode = extractFailureCode(response);
  let suggestion: ImprovementSuggestion | null = null;

  if (failureCode) {
    const entry = buildSuggestion(failureCode, table);
    if (entry) {
      suggestion = {
        named_regression: entry.named_regression,
        candidate_fix_surface: entry.candidate_fix_surface,
        next_action: {
          tool: "unbrowse_diagnose",
          args: { named_regression: entry.named_regression },
        },
      };
    }
  } else if (response.intent_status === "failed" || response.intent_status === "partial") {
    // Reflect with no carried failure_mode: we don't fabricate. The agent
    // gets improvement_suggestion: null and may choose to call diagnose
    // without a named target.
    suggestion = null;
  }

  return { ...response, improvement_suggestion: suggestion };
}

export { CANONICAL_FAILURE_CODES };
export type { CanonicalFailureCode };
