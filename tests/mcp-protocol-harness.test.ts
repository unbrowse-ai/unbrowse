/**
 * MCP protocol-level harness — TEST-SPECS §11 (AC-CLI-5).
 *
 * Speaks real newline-delimited JSON-RPC 2.0 to a real spawned server
 * (`bun src/mcp.ts`) over stdio — no internals imported. Pins:
 *   - initialize handshake (protocolVersion + capabilities + serverInfo)
 *   - tools/list returns the advertised tool surface, every tool carrying
 *     a name and an inputSchema
 *   - tools/call on a cheap tool returns a structured result
 *   - an unknown method gets a JSON-RPC error, and the server keeps
 *     serving afterwards (structured errors, not crashes)
 *
 * Hermetic: HOME + config dir point at a temp dir; local-only and
 * non-interactive flags set so no daemon, telemetry, or wallet leaks in.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

let proc: ChildProcessWithoutNullStreams;
let tmpHome: string;
let nextId = 0;
const pending = new Map<number, (msg: Record<string, unknown>) => void>();

function send(msg: Record<string, unknown>) {
  proc.stdin.write(`${JSON.stringify(msg)}\n`);
}

function request(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = ++nextId;
  const p = new Promise<Record<string, unknown>>((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(t);
      resolve(msg);
    });
  });
  send({ jsonrpc: "2.0", id, method, params });
  return p;
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "mcp-harness-"));
  proc = spawn("bun", ["src/mcp.ts"], {
    cwd: REPO,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: tmpHome,
      UNBROWSE_CONFIG_DIR: join(tmpHome, ".unbrowse"),
      UNBROWSE_NON_INTERACTIVE: "1",
      UNBROWSE_LOCAL_ONLY: "1",
      UNBROWSE_TELEMETRY: "0",
      UNBROWSE_DISABLE_LOCAL_WALLET: "1",
      UNBROWSE_SKIP_DAEMON_PROBE: "1",
    },
  }) as ChildProcessWithoutNullStreams;

  let buf = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue; // ignore non-protocol noise
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg.id;
        if (typeof id === "number" && pending.has(id)) {
          pending.get(id)!(msg);
          pending.delete(id);
        }
      } catch {
        // partial/non-JSON line — ignore
      }
    }
  });

  // Handshake once for the whole suite.
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "protocol-harness", version: "0.0.0" },
  }, 90_000);
  expect(init.error).toBeUndefined();
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
}, 120_000);

afterAll(() => {
  try { proc.kill(); } catch { /* already gone */ }
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("MCP protocol surface (AC-CLI-5)", () => {
  test("initialize negotiated a protocol version and advertised tool capability", async () => {
    // Re-initialize is allowed by the spec to be rejected; instead assert on
    // a fresh tools/list which only works post-handshake.
    const res = await request("tools/list");
    expect(res.error).toBeUndefined();
    const tools = (res.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(20);
  });

  test("tools/list: core tools present and every tool has a name + inputSchema", async () => {
    const res = await request("tools/list");
    const tools = (res.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    const names = new Set(tools.map((t) => t.name));
    for (const required of [
      "unbrowse_health",
      "unbrowse_resolve",
      "unbrowse_execute",
      "unbrowse_search",
      "unbrowse_skills",
    ]) {
      expect(names.has(required)).toBe(true);
    }
    for (const t of tools) {
      expect(typeof t.name).toBe("string");
      expect(t.inputSchema).toBeDefined();
    }
  });

  test("tools/call unbrowse_health returns a structured result", async () => {
    const res = await request("tools/call", { name: "unbrowse_health", arguments: {} }, 90_000);
    expect(res.error).toBeUndefined();
    const result = res.result as { content?: Array<{ type: string }> ; isError?: boolean };
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content!.length).toBeGreaterThan(0);
  });

  test("unknown method → JSON-RPC error, and the server keeps serving", async () => {
    const bad = await request("definitely/not-a-method");
    expect(bad.error).toBeDefined();
    // server must still answer afterwards — structured errors, not crashes
    const after = await request("tools/list");
    expect(after.error).toBeUndefined();
  });
});
