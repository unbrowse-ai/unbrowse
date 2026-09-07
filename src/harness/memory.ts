/**
 * Harness memory — durable, bounded persistence for the CLI harness.
 *
 * Layers (per agentic-harness-patterns §1):
 *  - instruction: curated policy (lives in config.json via settings.ts — not here)
 *  - harness runtime: last front-door result + session transcript (this module)
 *  - auto-memory: background harness-check outcomes (future)
 *
 * Storage: ~/.unbrowse/harness/last-run.json  and  ~/.unbrowse/harness/transcript.jsonl
 * Both are best-effort and fail-closed (missing/corrupt → empty).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getUnbrowseHome } from "../runtime/paths.js";

export interface HarnessLastRun {
  at: string;
  intent: string;
  url: string;
  ok: boolean;
  status?: string;
  next_step?: string;
  gate?: unknown;
  agent_path?: unknown;
  command: string;
}

export interface HarnessTranscriptEvent {
  at: string;
  command: string;
  ok?: boolean;
  status?: string;
  next_step?: string;
}

function harnessDir(): string {
  return join(getUnbrowseHome(), "harness");
}

function lastRunPath(): string {
  return join(harnessDir(), "last-run.json");
}

function transcriptPath(): string {
  return join(harnessDir(), "transcript.jsonl");
}

function ensureDir(): void {
  const dir = harnessDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readLastRun(): HarnessLastRun | null {
  try {
    const p = lastRunPath();
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as HarnessLastRun;
    if (!parsed || typeof parsed.at !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeLastRun(rec: HarnessLastRun): void {
  try {
    ensureDir();
    writeFileSync(lastRunPath(), JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // best-effort
  }
}

export function appendTranscript(ev: HarnessTranscriptEvent): void {
  try {
    ensureDir();
    appendFileSync(transcriptPath(), JSON.stringify(ev) + "\n", { mode: 0o600 });
  } catch {
    // best-effort
  }
}

export function readTranscript(limit = 20): HarnessTranscriptEvent[] {
  try {
    const p = transcriptPath();
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const last = lines.slice(-limit);
    const out: HarnessTranscriptEvent[] = [];
    for (const line of last) {
      try { out.push(JSON.parse(line) as HarnessTranscriptEvent); } catch { /* skip corrupt line */ }
    }
    return out;
  } catch {
    return [];
  }
}

export function lastRunPathForTest(): string { return lastRunPath(); }
export function transcriptPathForTest(): string { return transcriptPath(); }
