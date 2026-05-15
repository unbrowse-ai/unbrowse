// Recorded-baseline mode for the workbench proxy.
//
// Live mode spawns a v6.16.0 baseline daemon and fans every tools/call to
// it in parallel with candidate — doubling every browser navigation. For
// regression *verification* (did commit X fix probe Y) the baseline behavior
// is deterministic substrate code, not site-dependent, so re-observing it
// live every wave is redundant cost.
//
// Recorded mode records the baseline's resolve responses ONCE (see
// scripts/workbench-record-baseline.ts) into a golden manifest, then the
// proxy diffs candidate against the recorded response instead of a live
// sibling. resolve is called twice per probe and carries the richest delta
// (shortlist shape, ranked endpoints); it is keyed purely by intent+url so
// the recording stays valid across runs. Site-dependent execute deltas are
// out of scope for v1 (documented; the recorder skips them).

import { readFileSync, existsSync } from "node:fs";

// Arguments that vary per-run and must be stripped before keying so a
// recorded baseline matches a fresh candidate call for the same probe.
const VOLATILE_ARG_KEYS = new Set([
  "session_id",
  "tab_id",
  "skill_id", // run-specific publish id; resolve does not take it anyway
  "endpoint_id",
  "request_id",
]);

function canonicalizeArgs(args: unknown): string {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return JSON.stringify(args ?? null);
  }
  const obj = args as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (VOLATILE_ARG_KEYS.has(k)) continue;
    keep[k] = obj[k];
  }
  return JSON.stringify(keep);
}

/** Stable lookup key for a tools/call request: tool name + canonical args. */
export function recordedKey(toolName: string, args: unknown): string {
  return `${toolName}::${canonicalizeArgs(args)}`;
}

export interface GoldenEntry {
  key: string;
  tool: string;
  response: Record<string, unknown>;
  baseline_version?: string;
  recorded_at?: string;
}

export class RecordedBaseline {
  private readonly map = new Map<string, GoldenEntry>();
  readonly loadedFrom: string;
  readonly entryCount: number;

  constructor(manifestPath: string) {
    this.loadedFrom = manifestPath;
    if (!existsSync(manifestPath)) {
      this.entryCount = 0;
      return;
    }
    const text = readFileSync(manifestPath, "utf8");
    let n = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as GoldenEntry;
        if (entry && typeof entry.key === "string" && entry.response) {
          this.map.set(entry.key, entry);
          n++;
        }
      } catch {
        // skip malformed line; recording is append-only and a partial
        // last line should not nuke the whole golden set.
      }
    }
    this.entryCount = n;
  }

  /**
   * Look up the recorded baseline response for a tools/call request.
   * Returns null when this tool/args pair was not recorded (e.g. go,
   * snap, close, execute in v1 — only resolve is in the golden set).
   */
  lookup(toolName: string, args: unknown): GoldenEntry | null {
    return this.map.get(recordedKey(toolName, args)) ?? null;
  }
}

/** Tools whose baseline response is recorded in v1. Others are skipped. */
export const RECORDED_TOOLS = new Set(["unbrowse_resolve"]);
