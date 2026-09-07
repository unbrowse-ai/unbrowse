import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compactSessionLog,
  readActiveSessions,
  recordSessionCreate,
  recordSessionDrop,
  recordSessionUpdate,
  type PersistedSession,
} from "../src/api/session-store.js";

let tmp: string;
let storePath: string;

function makeSession(overrides: Partial<PersistedSession> = {}): PersistedSession {
  return {
    sessionId: "sess-" + Math.random().toString(36).slice(2, 10),
    tabId: "tab-" + Math.random().toString(36).slice(2, 10),
    url: "https://example.com/",
    domain: "example.com",
    harActive: true,
    brokerPort: 9223,
    ts: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "unbrowse-sess-"));
  storePath = path.join(tmp, "sessions.jsonl");
  process.env.UNBROWSE_SESSION_STORE = storePath;
});

afterEach(() => {
  delete process.env.UNBROWSE_SESSION_STORE;
  rmSync(tmp, { recursive: true, force: true });
});

describe("session-store", () => {
  it("returns empty array when no file exists", () => {
    expect(readActiveSessions()).toEqual([]);
  });

  it("roundtrips a create event", () => {
    const s = makeSession();
    recordSessionCreate(s);
    const active = readActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].sessionId).toBe(s.sessionId);
    expect(active[0].tabId).toBe(s.tabId);
    expect(active[0].url).toBe(s.url);
  });

  it("create + drop collapses to no active sessions", () => {
    const s = makeSession();
    recordSessionCreate(s);
    recordSessionDrop(s.sessionId);
    expect(readActiveSessions()).toHaveLength(0);
  });

  it("update patches url and domain on replay", () => {
    const s = makeSession({ url: "https://example.com/a", domain: "example.com" });
    recordSessionCreate(s);
    recordSessionUpdate({ sessionId: s.sessionId, url: "https://example.com/b" });
    const active = readActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].url).toBe("https://example.com/b");
    expect(active[0].domain).toBe("example.com");
  });

  it("update on missing session is a no-op", () => {
    recordSessionUpdate({ sessionId: "ghost", url: "https://nope" });
    expect(readActiveSessions()).toHaveLength(0);
  });

  it("survives malformed lines (corruption-tolerant)", () => {
    const s = makeSession();
    recordSessionCreate(s);
    // Append garbage
    writeFileSync(storePath, readFileSync(storePath, "utf8") + "{not json\nalso garbage\n", "utf8");
    const active = readActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].sessionId).toBe(s.sessionId);
  });

  it("compaction collapses event log to one create per survivor", () => {
    const a = makeSession();
    const b = makeSession();
    recordSessionCreate(a);
    recordSessionCreate(b);
    recordSessionUpdate({ sessionId: a.sessionId, url: "https://x" });
    recordSessionUpdate({ sessionId: a.sessionId, url: "https://y" });
    recordSessionDrop(b.sessionId);

    const before = readFileSync(storePath, "utf8").split("\n").filter(Boolean).length;
    expect(before).toBe(5);

    compactSessionLog();
    const after = readFileSync(storePath, "utf8").split("\n").filter(Boolean).length;
    expect(after).toBe(1);

    const active = readActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].sessionId).toBe(a.sessionId);
    expect(active[0].url).toBe("https://y");
  });

  it("concurrent appends from same process don't lose events", () => {
    // Simulate burst of mutations
    const sessions = Array.from({ length: 20 }, () => makeSession());
    for (const s of sessions) recordSessionCreate(s);
    const active = readActiveSessions();
    expect(active).toHaveLength(20);
    const ids = new Set(active.map((s) => s.sessionId));
    for (const s of sessions) expect(ids.has(s.sessionId)).toBe(true);
  });

  it("respects UNBROWSE_SESSION_STORE env override", () => {
    const altPath = path.join(tmp, "alt.jsonl");
    process.env.UNBROWSE_SESSION_STORE = altPath;
    const s = makeSession();
    recordSessionCreate(s);
    expect(() => readFileSync(altPath, "utf8")).not.toThrow();
    expect(readActiveSessions()).toHaveLength(1);
  });
});
