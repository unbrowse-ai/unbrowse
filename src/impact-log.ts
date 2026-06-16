/**
 * Local per-agent impact log.
 *
 * Every resolve/execute appends one line here with the savings it delivered
 * (time, tokens, dollars, browser avoided). `unbrowse stats` and the
 * unbrowse_stats MCP tool read this file to show lifetime impact without
 * needing a new backend endpoint.
 *
 * Format: JSONL at ~/.unbrowse/impact-log.jsonl (or $UNBROWSE_CONFIG_DIR).
 * Rotates when the file exceeds ~5MB.
 */

import { existsSync, mkdirSync, appendFileSync, statSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_ROTATIONS = 3;

export interface ImpactLogEntry {
  ts: string;
  command: "resolve" | "execute" | "browse" | string;
  source?: string;
  domain?: string;
  // NOTE: the raw `intent` is deliberately NOT persisted here — it is a hole
  // value that can carry user-typed PII/secrets, and nothing reads it back
  // (readImpactSummary aggregates only time/tokens/cost/source). Keep it out of
  // this at-rest local log. (privacy-at-rest invariant, Phase A.)
  skill_id?: string;
  endpoint_id?: string;
  time_saved_ms?: number;
  time_saved_pct?: number;
  tokens_saved?: number;
  tokens_saved_pct?: number;
  cost_saved_uc?: number;
  browser_avoided?: boolean;
  success?: boolean;
}

export interface ImpactSummary {
  total_runs: number;
  successful_runs: number;
  browser_avoided_runs: number;
  total_time_saved_ms: number;
  total_tokens_saved: number;
  total_cost_saved_uc: number;
  avg_time_saved_pct: number;
  avg_tokens_saved_pct: number;
  by_source: Record<string, number>;
  first_entry_at: string | null;
  last_entry_at: string | null;
}

function getLogDir(): string {
  if (process.env.UNBROWSE_CONFIG_DIR) return process.env.UNBROWSE_CONFIG_DIR;
  const profile = process.env.UNBROWSE_PROFILE?.trim();
  return profile
    ? join(homedir(), ".unbrowse", "profiles", profile)
    : join(homedir(), ".unbrowse");
}

export function getImpactLogPath(): string {
  return join(getLogDir(), "impact-log.jsonl");
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < MAX_LOG_BYTES) return;
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const older = `${path}.${i}`;
      if (!existsSync(older)) continue;
      if (i === MAX_ROTATIONS) {
        try { unlinkSync(older); } catch {}
      } else {
        try { renameSync(older, `${path}.${i + 1}`); } catch {}
      }
    }
    renameSync(path, `${path}.1`);
  } catch {
    // best-effort; never throw from logging
  }
}

/** Append a single impact record. Fire-and-forget; never throws. */
export function appendImpact(entry: ImpactLogEntry): void {
  try {
    const hasSignal =
      (entry.time_saved_ms ?? 0) > 0 ||
      (entry.tokens_saved ?? 0) > 0 ||
      (entry.cost_saved_uc ?? 0) > 0 ||
      entry.browser_avoided === true;
    if (!hasSignal) return;

    const path = getImpactLogPath();
    ensureDir(path);
    rotateIfNeeded(path);
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // never surface logging errors
  }
}

/**
 * Extract an ImpactLogEntry from an orchestrator result's `impact` field.
 * Returns null if the result has no impact data.
 */
export function impactFromResult(
  command: string,
  result: unknown,
  extras: { intent?: string; domain?: string; skill_id?: string; endpoint_id?: string } = {},
): ImpactLogEntry | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const impact = (r.impact ?? null) as Record<string, unknown> | null;
  if (!impact || typeof impact !== "object") return null;

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;

  return {
    ts: new Date().toISOString(),
    command,
    source: typeof impact.source === "string" ? impact.source : undefined,
    domain: extras.domain,
    // `extras.intent` is intentionally dropped (see ImpactLogEntry note) — never
    // persisted to the at-rest log.
    skill_id: extras.skill_id ?? (typeof r.skill_id === "string" ? r.skill_id : undefined),
    endpoint_id: extras.endpoint_id ?? (typeof r.endpoint_id === "string" ? r.endpoint_id : undefined),
    time_saved_ms: num(impact.time_saved_ms),
    time_saved_pct: num(impact.time_saved_pct),
    tokens_saved: num(impact.tokens_saved),
    tokens_saved_pct: num(impact.tokens_saved_pct),
    cost_saved_uc: num(impact.cost_saved_uc),
    browser_avoided: impact.browser_avoided === true,
    success: r.error == null,
  };
}

/** Read and aggregate the full impact log (across rotations). Safe on missing file. */
export function readImpactSummary(): ImpactSummary {
  const path = getImpactLogPath();
  const summary: ImpactSummary = {
    total_runs: 0,
    successful_runs: 0,
    browser_avoided_runs: 0,
    total_time_saved_ms: 0,
    total_tokens_saved: 0,
    total_cost_saved_uc: 0,
    avg_time_saved_pct: 0,
    avg_tokens_saved_pct: 0,
    by_source: {},
    first_entry_at: null,
    last_entry_at: null,
  };

  const files: string[] = [];
  for (let i = MAX_ROTATIONS; i >= 1; i--) {
    const rotated = `${path}.${i}`;
    if (existsSync(rotated)) files.push(rotated);
  }
  if (existsSync(path)) files.push(path);
  if (files.length === 0) return summary;

  let timePctSum = 0;
  let timePctCount = 0;
  let tokenPctSum = 0;
  let tokenPctCount = 0;

  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let e: ImpactLogEntry;
      try {
        e = JSON.parse(trimmed) as ImpactLogEntry;
      } catch {
        continue;
      }
      summary.total_runs += 1;
      if (e.success !== false) summary.successful_runs += 1;
      if (e.browser_avoided) summary.browser_avoided_runs += 1;
      summary.total_time_saved_ms += e.time_saved_ms ?? 0;
      summary.total_tokens_saved += e.tokens_saved ?? 0;
      summary.total_cost_saved_uc += e.cost_saved_uc ?? 0;
      if (typeof e.time_saved_pct === "number") {
        timePctSum += e.time_saved_pct;
        timePctCount += 1;
      }
      if (typeof e.tokens_saved_pct === "number") {
        tokenPctSum += e.tokens_saved_pct;
        tokenPctCount += 1;
      }
      if (e.source) {
        summary.by_source[e.source] = (summary.by_source[e.source] ?? 0) + 1;
      }
      if (!summary.first_entry_at || e.ts < summary.first_entry_at) summary.first_entry_at = e.ts;
      if (!summary.last_entry_at || e.ts > summary.last_entry_at) summary.last_entry_at = e.ts;
    }
  }

  summary.avg_time_saved_pct = timePctCount > 0 ? Math.round(timePctSum / timePctCount) : 0;
  summary.avg_tokens_saved_pct = tokenPctCount > 0 ? Math.round(tokenPctSum / tokenPctCount) : 0;
  return summary;
}

/** For tests only. */
export function _clearImpactLogForTests(): void {
  const path = getImpactLogPath();
  try {
    if (existsSync(path)) unlinkSync(path);
    for (let i = 1; i <= MAX_ROTATIONS + 1; i++) {
      const rotated = `${path}.${i}`;
      if (existsSync(rotated)) unlinkSync(rotated);
    }
  } catch {
    // ignore
  }
}
