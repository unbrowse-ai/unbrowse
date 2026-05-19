/**
 * No-mock tests for the new MCP user-context resources:
 *   - unbrowse://auth/profiles
 *   - unbrowse://cookies/domains
 *   - unbrowse://browser-history/recent
 *   - unbrowse://sessions/active
 *
 * Spawns the real `bun src/mcp.ts` with a tmp HOME so the resources read
 * from a sandboxed vault / session store / browser jar (the browser cookie
 * + history scanners simply find no installed browsers under tmp HOME and
 * return empty results — that's a valid expected shape, not a failure).
 *
 * Per CLAUDE.md "Never mock in tests": all reads hit real readers, real
 * filesystem, real JSON-RPC over stdio. The subprocess pattern mirrors
 * tests/mcp-stats-resources.test.ts.
 */

import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MCP_ENTRY = join(REPO_ROOT, "src/mcp.ts");

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ubmcp-userctx-"));
});

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

interface RpcResponse { id: number; result?: unknown; error?: unknown }

async function rpcCall(messages: string[], env: Record<string, string> = {}): Promise<{ responses: RpcResponse[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [MCP_ENTRY], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmpHome,
        UNBROWSE_CONFIG_DIR: join(tmpHome, ".unbrowse"),
        UNBROWSE_API_KEY: "uk_test_stub",
        UNBROWSE_TELEMETRY_ENABLED: "0",
        // Override session store path so the resource reads from the test
        // sandbox even if the substrate would have defaulted elsewhere.
        UNBROWSE_SESSION_STORE: join(tmpHome, "sessions.jsonl"),
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);

    for (const m of messages) child.stdin.write(m + "\n");

    const deadline = Date.now() + 20_000;
    const poll = setInterval(() => {
      const lineCount = stdout.split("\n").filter((l) => l.trim()).length;
      if (lineCount >= messages.length || Date.now() > deadline) {
        clearInterval(poll);
        try { child.stdin.end(); } catch {}
        try { child.kill("SIGTERM"); } catch {}
      }
    }, 100);

    child.on("close", () => {
      clearInterval(poll);
      const responses: RpcResponse[] = [];
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const parsed = JSON.parse(t) as RpcResponse;
          if (typeof parsed.id === "number") responses.push(parsed);
        } catch {}
      }
      resolve({ responses, stderr });
    });
  });
}

function initializeMsg(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "userctx-test", version: "0" },
    },
  });
}

function listResourcesMsg(id: number): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "resources/list" });
}

function readResourceMsg(id: number, uri: string): string {
  return JSON.stringify({
    jsonrpc: "2.0", id, method: "resources/read", params: { uri },
  });
}

test("resources/list includes all four user-context URIs", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    listResourcesMsg(2),
  ]);
  const listResponse = responses.find((r) => r.id === 2);
  expect(listResponse).toBeDefined();
  const result = listResponse!.result as { resources: Array<{ uri: string; name: string; mimeType?: string }> };
  expect(Array.isArray(result.resources)).toBe(true);
  const uris = result.resources.map((r) => r.uri);
  expect(uris).toContain("unbrowse://auth/profiles");
  expect(uris).toContain("unbrowse://cookies/domains");
  expect(uris).toContain("unbrowse://browser-history/recent");
  expect(uris).toContain("unbrowse://sessions/active");

  const auth = result.resources.find((r) => r.uri === "unbrowse://auth/profiles")!;
  expect(auth.name).toBe("Saved Auth Profiles");
  expect(auth.mimeType).toBe("application/json");
}, 30_000);

test("resources/read unbrowse://auth/profiles returns empty list with valid shape on clean HOME", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://auth/profiles"),
  ]);
  const readResponse = responses.find((r) => r.id === 2);
  expect(readResponse).toBeDefined();
  const result = readResponse!.result as { contents: Array<{ uri: string; text: string }> };
  expect(result.contents).toHaveLength(1);
  expect(result.contents[0].uri).toBe("unbrowse://auth/profiles");

  const body = JSON.parse(result.contents[0].text) as {
    count: number;
    profiles: Array<{ domain: string; stored_at: string | null; expires_at: string | null; account_key: string }>;
    source: string;
  };
  // Clean tmp HOME may or may not yield zero profiles depending on whether
  // the host keychain backend leaks across HOMEs (macOS keychain is per-user,
  // not per-HOME). The contract we care about is structural: arrays exist,
  // shape is right. Don't pin counts.
  expect(typeof body.count).toBe("number");
  expect(Array.isArray(body.profiles)).toBe(true);
  expect(body.count).toBe(body.profiles.length);
  expect(typeof body.source).toBe("string");
  for (const p of body.profiles) {
    expect(typeof p.domain).toBe("string");
    expect(typeof p.account_key).toBe("string");
    // stored_at and expires_at are nullable strings
    expect(p.stored_at === null || typeof p.stored_at === "string").toBe(true);
    expect(p.expires_at === null || typeof p.expires_at === "string").toBe(true);
  }
}, 30_000);

test("resources/read unbrowse://cookies/domains returns scan-report shape (browsers_scanned + browsers_skipped)", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://cookies/domains"),
  ]);
  const result = responses.find((r) => r.id === 2)!.result as { contents: Array<{ text: string }> };
  const body = JSON.parse(result.contents[0].text) as {
    domains: Array<{ domain: string; browsers: string[]; session_cookie_count: number; total_cookie_count: number; newest_cookie_at: string | null }>;
    browsers_scanned: string[];
    browsers_skipped: string[];
  };
  expect(Array.isArray(body.domains)).toBe(true);
  expect(Array.isArray(body.browsers_scanned)).toBe(true);
  expect(Array.isArray(body.browsers_skipped)).toBe(true);
  // Either we found some browsers or all are skipped — together they should
  // cover the known set, never empty-both.
  expect(body.browsers_scanned.length + body.browsers_skipped.length).toBeGreaterThan(0);
  // Sort invariant: session_cookie_count must be non-increasing
  for (let i = 1; i < body.domains.length; i++) {
    expect(body.domains[i].session_cookie_count).toBeLessThanOrEqual(body.domains[i - 1].session_cookie_count);
  }
}, 30_000);

test("resources/read unbrowse://browser-history/recent returns disabled-shape when UNBROWSE_EXPOSE_HISTORY is unset", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://browser-history/recent"),
  ], { /* explicitly NOT setting UNBROWSE_EXPOSE_HISTORY */ });
  const result = responses.find((r) => r.id === 2)!.result as { contents: Array<{ text: string }> };
  const body = JSON.parse(result.contents[0].text) as Record<string, unknown>;
  expect(body.enabled).toBe(false);
  expect(typeof body.hint).toBe("string");
  expect(String(body.hint)).toMatch(/UNBROWSE_EXPOSE_HISTORY/);
  expect(typeof body.redaction_rule).toBe("string");
  // Disabled-shape must NOT contain any raw history fields
  expect("domains" in body).toBe(false);
  expect("since" in body).toBe(false);
}, 30_000);

test("resources/read unbrowse://browser-history/recent returns redacted history shape when enabled", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://browser-history/recent"),
  ], { UNBROWSE_EXPOSE_HISTORY: "1" });
  const result = responses.find((r) => r.id === 2)!.result as { contents: Array<{ text: string }> };
  const body = JSON.parse(result.contents[0].text) as {
    enabled: boolean;
    since: string;
    until: string;
    count: number;
    domains: Array<{ etld_plus_one: string; visit_count: number; last_visit: string }>;
    source_browsers: string[];
    redacted: boolean;
    redaction_rule: string;
  };
  expect(body.enabled).toBe(true);
  // since/until must be valid ISO timestamps
  expect(() => new Date(body.since).toISOString()).not.toThrow();
  expect(() => new Date(body.until).toISOString()).not.toThrow();
  expect(typeof body.count).toBe("number");
  expect(Array.isArray(body.domains)).toBe(true);
  expect(body.count).toBe(body.domains.length);
  // Privacy: redacted flag is true by construction
  expect(body.redacted).toBe(true);
  // Every domain entry must be eTLD+1 only — no slashes, no spaces, no query.
  for (const d of body.domains) {
    expect(d.etld_plus_one).not.toMatch(/[\/\s?#]/);
    expect(typeof d.visit_count).toBe("number");
    expect(d.visit_count).toBeGreaterThan(0);
  }
}, 30_000);

test("resources/read unbrowse://sessions/active returns empty count:0 with clean session store", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://sessions/active"),
  ]);
  const result = responses.find((r) => r.id === 2)!.result as { contents: Array<{ text: string }> };
  const body = JSON.parse(result.contents[0].text) as {
    count: number;
    sessions: Array<unknown>;
    source_path: string;
  };
  expect(body.count).toBe(0);
  expect(Array.isArray(body.sessions)).toBe(true);
  expect(body.sessions.length).toBe(0);
  expect(typeof body.source_path).toBe("string");
  // Must use the test-overridden session path
  expect(body.source_path).toBe(join(tmpHome, "sessions.jsonl"));
}, 30_000);

test("resources/read returns Unknown resource error for an unrecognized user-context URI", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://auth/does-not-exist"),
  ]);
  const r = responses.find((x) => x.id === 2);
  expect(r).toBeDefined();
  expect(r!.error).toBeDefined();
}, 30_000);
