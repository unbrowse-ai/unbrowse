/**
 * Persistent browse-session log at ~/.unbrowse/sessions.jsonl.
 *
 * Purpose: make mcp-serve disposable. Any state held in the in-memory
 * `browseSessions` Map must be reconstructable from disk after the daemon
 * is reaped, killed, or crashes. Active browse sessions survive daemon
 * restarts; the next `unbrowse mcp` invocation rehydrates from this file
 * and re-attaches to live Kuri tabs.
 *
 * Format: append-only JSONL, one event per line:
 *   {op: "create", sessionId, tabId, url, domain, brokerPort?, harActive, ts}
 *   {op: "update", sessionId, url?, domain?, harActive?, ts}
 *   {op: "drop",   sessionId, ts}
 *
 * Compaction: when the file exceeds COMPACTION_THRESHOLD lines, the writer
 * rewrites it as a single "create" event per surviving session. Concurrent
 * compaction is prevented by the daemon-singleton invariant (pid-file in
 * runtime/local-server.ts ensures only one mcp-serve runs at a time).
 *
 * Runtime fields not persisted: `client` (BrowseSessionClient — function
 * holder, reconstructed from brokerPort).
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface PersistedSession {
  sessionId: string;
  tabId: string;
  url: string;
  domain: string;
  harActive: boolean;
  brokerPort?: number;
  /** ms timestamp of the last event that touched this session. */
  ts: number;
}

type SessionEvent =
  | { op: "create"; sessionId: string; tabId: string; url: string; domain: string; brokerPort?: number; harActive: boolean; ts: number }
  | { op: "update"; sessionId: string; url?: string; domain?: string; harActive?: boolean; ts: number }
  | { op: "drop"; sessionId: string; ts: number };

const DEFAULT_PATH = path.join(homedir(), ".unbrowse", "sessions.jsonl");
const COMPACTION_THRESHOLD = 256;

function sessionStorePath(): string {
  return process.env.UNBROWSE_SESSION_STORE ?? DEFAULT_PATH;
}

function ensureDir(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
}

function readAllEvents(file: string): SessionEvent[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as SessionEvent;
      if (ev && typeof ev === "object" && typeof ev.op === "string" && typeof ev.sessionId === "string") {
        events.push(ev);
      }
    } catch {
      // skip malformed line — corruption-tolerant
    }
  }
  return events;
}

function replayEvents(events: SessionEvent[]): Map<string, PersistedSession> {
  const map = new Map<string, PersistedSession>();
  for (const ev of events) {
    if (ev.op === "create") {
      map.set(ev.sessionId, {
        sessionId: ev.sessionId,
        tabId: ev.tabId,
        url: ev.url,
        domain: ev.domain,
        harActive: ev.harActive,
        brokerPort: ev.brokerPort,
        ts: ev.ts,
      });
    } else if (ev.op === "update") {
      const cur = map.get(ev.sessionId);
      if (!cur) continue;
      map.set(ev.sessionId, {
        ...cur,
        url: ev.url ?? cur.url,
        domain: ev.domain ?? cur.domain,
        harActive: ev.harActive ?? cur.harActive,
        ts: ev.ts,
      });
    } else if (ev.op === "drop") {
      map.delete(ev.sessionId);
    }
  }
  return map;
}

/** Read the current active set by replaying the log. */
export function readActiveSessions(file = sessionStorePath()): PersistedSession[] {
  const events = readAllEvents(file);
  return [...replayEvents(events).values()];
}

function appendEvent(event: SessionEvent, file: string): void {
  ensureDir(file);
  appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  maybeCompact(file);
}

function countLines(file: string): number {
  try {
    return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function compactInPlace(file: string): void {
  const survivors = readActiveSessions(file);
  const tmp = file + ".tmp";
  ensureDir(file);
  writeFileSync(
    tmp,
    survivors.map((s) =>
      JSON.stringify({
        op: "create",
        sessionId: s.sessionId,
        tabId: s.tabId,
        url: s.url,
        domain: s.domain,
        brokerPort: s.brokerPort,
        harActive: s.harActive,
        ts: s.ts,
      }) + "\n"
    ).join(""),
    "utf8",
  );
  renameSync(tmp, file);
}

function maybeCompact(file: string): void {
  if (countLines(file) < COMPACTION_THRESHOLD) return;
  try {
    compactInPlace(file);
  } catch {
    // best-effort — corruption-tolerant
  }
}

/** Append a "create" event. */
export function recordSessionCreate(session: PersistedSession, file = sessionStorePath()): void {
  appendEvent({
    op: "create",
    sessionId: session.sessionId,
    tabId: session.tabId,
    url: session.url,
    domain: session.domain,
    brokerPort: session.brokerPort,
    harActive: session.harActive,
    ts: session.ts,
  }, file);
}

/** Append an "update" event (partial — only specify changed fields). */
export function recordSessionUpdate(
  patch: { sessionId: string; url?: string; domain?: string; harActive?: boolean },
  file = sessionStorePath(),
): void {
  appendEvent({
    op: "update",
    sessionId: patch.sessionId,
    url: patch.url,
    domain: patch.domain,
    harActive: patch.harActive,
    ts: Date.now(),
  }, file);
}

/** Append a "drop" event. Idempotent — dropping a missing session is a no-op on replay. */
export function recordSessionDrop(sessionId: string, file = sessionStorePath()): void {
  appendEvent({ op: "drop", sessionId, ts: Date.now() }, file);
}

/** Force compaction now (test hook). */
export function compactSessionLog(file = sessionStorePath()): void {
  compactInPlace(file);
}

/** Internal — for tests. */
export const __internals = { DEFAULT_PATH, COMPACTION_THRESHOLD, sessionStorePath };
