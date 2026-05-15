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

import { readFileSync, existsSync, statSync } from "node:fs";

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
  private map = new Map<string, GoldenEntry>();
  readonly loadedFrom: string;
  private lastMtimeMs = -1;
  private lastSize = -1;

  constructor(manifestPath: string) {
    this.loadedFrom = manifestPath;
    this.reloadIfChanged();
  }

  /** Current entry count (re-stats the file first). */
  get entryCount(): number {
    this.reloadIfChanged();
    return this.map.size;
  }

  /**
   * Re-read the manifest if it appeared, grew, or changed since last load.
   * The recorder appends incrementally and may finish AFTER the proxy
   * spawned; re-stat on access means a golden recorded mid-session takes
   * effect with no proxy restart and no /mcp. Cheap: one statSync per call.
   */
  private reloadIfChanged(): void {
    let mtimeMs = -1;
    let size = -1;
    try {
      const st = statSync(this.loadedFrom);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {
      // file absent: if we had entries they are now stale-but-kept (a
      // transient unlink during re-record should not blank the set);
      // if we never had any, stay empty.
      if (this.lastMtimeMs === -1) return;
    }
    if (mtimeMs === this.lastMtimeMs && size === this.lastSize) return;
    this.lastMtimeMs = mtimeMs;
    this.lastSize = size;

    const next = new Map<string, GoldenEntry>();
    if (existsSync(this.loadedFrom)) {
      const text = readFileSync(this.loadedFrom, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as GoldenEntry;
          if (entry && typeof entry.key === "string" && entry.response) {
            next.set(entry.key, entry);
          }
        } catch {
          // skip malformed (partial last line during an in-progress
          // append); the rest of the golden set stays valid.
        }
      }
    }
    if (next.size > 0 || this.map.size === 0) {
      // only swap in a non-empty set, or when we had nothing anyway.
      // Guards against an empty/truncated read blanking a good golden.
      this.map = next;
    }
  }

  /**
   * Look up the recorded baseline response for a tools/call request.
   * Returns null when this tool/args pair was not recorded (e.g. go,
   * snap, close, execute in v1 — only resolve is in the golden set).
   */
  lookup(toolName: string, args: unknown): GoldenEntry | null {
    this.reloadIfChanged();
    return this.map.get(recordedKey(toolName, args)) ?? null;
  }

  /** True when a non-empty golden is present (the recorded-mode switch). */
  hasGolden(): boolean {
    return this.entryCount > 0;
  }
}

/** Tools whose baseline response is recorded in v1. Others are skipped. */
export const RECORDED_TOOLS = new Set(["unbrowse_resolve"]);
