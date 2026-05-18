/**
 * No-mock test for the new MCP stats resources.
 *
 * Spawns the real `bun src/mcp.ts`, sends `initialize` + `resources/list`
 * + `resources/read` over stdio JSON-RPC, asserts both
 * `unbrowse://stats/time-saved` and `unbrowse://stats/tokens-saved`
 * appear in the resource list and return the expected projection of the
 * impact-log summary.
 *
 * Two read modes per resource:
 *   1. empty impact log (clean tmp HOME) — every numeric field reads 0,
 *      date range is null, no error.
 *   2. seeded impact log (one synthetic entry per resource shape) —
 *      totals reflect the seed.
 *
 * Per CLAUDE.md: no mocks. Real subprocess, real readImpactSummary(),
 * real JSONL impact log written to a temp HOME the test owns.
 */

import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MCP_ENTRY = join(REPO_ROOT, "src/mcp.ts");

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ubmcp-stats-"));
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
      // Explicit UNBROWSE_CONFIG_DIR so the impact log path is what this
      // test owns. Otherwise the dotenv loader at the top of src/mcp.ts
      // can pick up a .env / .env.runtime in the repo root that points
      // the log somewhere outside HOME and the seed becomes invisible.
      env: {
        PATH: process.env.PATH ?? "",
        HOME: tmpHome,
        UNBROWSE_CONFIG_DIR: join(tmpHome, ".unbrowse"),
        UNBROWSE_API_KEY: "uk_test_stub",
        UNBROWSE_TELEMETRY_ENABLED: "0",
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

    const deadline = Date.now() + 15_000;
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
      clientInfo: { name: "stats-test", version: "0" },
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

function seedImpactLog(): void {
  // impact-log.ts: getLogDir() = $UNBROWSE_CONFIG_DIR or ~/.unbrowse, so
  // with HOME=tmpHome the log path is $tmpHome/.unbrowse/impact-log.jsonl.
  const dir = join(tmpHome, ".unbrowse");
  mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      ts: "2026-05-18T10:00:00.000Z",
      command: "execute",
      source: "marketplace",
      domain: "example.com",
      time_saved_ms: 3000,
      time_saved_pct: 80,
      tokens_saved: 4500,
      tokens_saved_pct: 60,
      browser_avoided: true,
      success: true,
    }),
    JSON.stringify({
      ts: "2026-05-18T11:00:00.000Z",
      command: "execute",
      source: "marketplace",
      domain: "example.com",
      time_saved_ms: 5000,
      time_saved_pct: 90,
      tokens_saved: 1500,
      tokens_saved_pct: 50,
      browser_avoided: true,
      success: true,
    }),
  ];
  writeFileSync(join(dir, "impact-log.jsonl"), lines.join("\n") + "\n");
}

test("resources/list includes both stats URIs alongside any workflow resources", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    listResourcesMsg(2),
  ]);
  const listResponse = responses.find((r) => r.id === 2);
  expect(listResponse).toBeDefined();
  const result = listResponse!.result as { resources: Array<{ uri: string; name: string; mimeType?: string }> };
  expect(Array.isArray(result.resources)).toBe(true);
  const uris = result.resources.map((r) => r.uri);
  expect(uris).toContain("unbrowse://stats/time-saved");
  expect(uris).toContain("unbrowse://stats/tokens-saved");
  const time = result.resources.find((r) => r.uri === "unbrowse://stats/time-saved")!;
  expect(time.name).toBe("Time Saved (Unbrowse)");
  expect(time.mimeType).toBe("application/json");
}, 30_000);

test("resources/read time-saved returns zeros and a source_path when impact log is empty", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://stats/time-saved"),
  ]);
  const readResponse = responses.find((r) => r.id === 2);
  expect(readResponse).toBeDefined();
  const result = readResponse!.result as { contents: Array<{ uri: string; text: string }> };
  expect(result.contents).toHaveLength(1);
  expect(result.contents[0].uri).toBe("unbrowse://stats/time-saved");
  const body = JSON.parse(result.contents[0].text) as {
    total_time_saved_ms: number;
    total_time_saved_seconds: number;
    total_time_saved_minutes: number;
    avg_time_saved_pct: number;
    total_runs: number;
    successful_runs: number;
    browser_avoided_runs: number;
    first_entry_at: string | null;
    last_entry_at: string | null;
    source_path: string;
  };
  expect(body.total_time_saved_ms).toBe(0);
  expect(body.total_time_saved_seconds).toBe(0);
  expect(body.total_time_saved_minutes).toBe(0);
  expect(body.total_runs).toBe(0);
  expect(body.first_entry_at).toBeNull();
  expect(body.last_entry_at).toBeNull();
  expect(typeof body.source_path).toBe("string");
  expect(body.source_path.length).toBeGreaterThan(0);
}, 30_000);

test("resources/read time-saved reflects seeded impact log entries (totals + rolled-up units)", async () => {
  seedImpactLog();
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://stats/time-saved"),
  ]);
  const result = responses.find((r) => r.id === 2)!.result as { contents: Array<{ text: string }> };
  const body = JSON.parse(result.contents[0].text) as Record<string, unknown>;
  // 3000 + 5000 = 8000ms total
  expect(body.total_time_saved_ms).toBe(8000);
  expect(body.total_time_saved_seconds).toBe(8);
  expect(body.total_time_saved_minutes).toBe(0); // round(8000/60000)
  // (80 + 90) / 2 = 85
  expect(body.avg_time_saved_pct).toBe(85);
  expect(body.total_runs).toBe(2);
  expect(body.successful_runs).toBe(2);
  expect(body.browser_avoided_runs).toBe(2);
  expect(body.first_entry_at).toBe("2026-05-18T10:00:00.000Z");
  expect(body.last_entry_at).toBe("2026-05-18T11:00:00.000Z");
}, 30_000);

test("resources/read tokens-saved reflects seeded impact log entries", async () => {
  seedImpactLog();
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://stats/tokens-saved"),
  ]);
  const result = responses.find((r) => r.id === 2)!.result as { contents: Array<{ text: string }> };
  const body = JSON.parse(result.contents[0].text) as Record<string, unknown>;
  // 4500 + 1500 = 6000 tokens total
  expect(body.total_tokens_saved).toBe(6000);
  // (60 + 50) / 2 = 55
  expect(body.avg_tokens_saved_pct).toBe(55);
  expect(body.total_runs).toBe(2);
  // tokens-saved projection deliberately excludes browser_avoided_runs (that's a
  // time-saved concern); the structural contract is "this resource projects
  // ONLY token-related fields plus run-count audit info"
  expect("browser_avoided_runs" in body).toBe(false);
}, 30_000);

test("resources/read returns Unknown resource error for an unrecognized URI", async () => {
  const { responses } = await rpcCall([
    initializeMsg(1),
    readResourceMsg(2, "unbrowse://stats/does-not-exist"),
  ]);
  const r = responses.find((x) => x.id === 2);
  expect(r).toBeDefined();
  expect(r!.error).toBeDefined();
}, 30_000);
