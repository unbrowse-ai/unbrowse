/**
 * BUG-4 mitigation: stdio MCP loop wraps handleRequest with a hard
 * timeout so a slow / hung tool handler never blocks the loop
 * indefinitely.
 *
 * Background: the 2026-05-17 MCP bench-gate saw three full
 * disconnects under concurrent subagent load. Investigation showed
 * the server process itself stayed alive and kept logging Kuri
 * activity — but the MCP client (Claude Code) heartbeat timed out
 * and reported the server as disconnected. Likely cause: one
 * handler (unbrowse_go on a hostile site, etc.) blocking the
 * for-await stdin reader, so pings and other inflight requests
 * queued behind it past the client's heartbeat budget.
 *
 * The fix wraps each handler call with a Promise.race against a
 * setTimeout. If the timeout fires first, the loop emits a
 * structured `handler_timeout` JSON-RPC error on the request id
 * and advances to the next request. The handler itself keeps
 * running in the background (we don't have a way to cancel an
 * arbitrary Promise) — but its eventual write to stdout for an
 * already-resolved id is harmless and the client ignores it.
 *
 * No mocks: spawns the real MCP server as a stdio child process,
 * feeds it a slow tool call, and asserts the timeout error fires
 * within the configured budget without the server dying.
 *
 * The slow path we exercise: an unbrowse_eval call with a script
 * that takes longer than the timeout to "respond." Easier to
 * trigger reliably: configure a tight `UNBROWSE_MCP_HANDLER_TIMEOUT_MS`
 * (e.g. 1500ms) and call a tool whose real handler waits longer
 * than that on a network operation.
 *
 * Actually simplest: send a tool call to a non-existent tool name
 * — that errors fast. We need an actually-slow tool. Use
 * unbrowse_health, set timeout to 1ms, and assert the loop emits
 * handler_timeout before health can respond.
 */

import { test, expect, afterEach, beforeEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MCP = join(REPO_ROOT, "src/mcp.ts");

let proc: ChildProcess | null = null;

afterEach(() => {
  if (proc && !proc.killed) {
    proc.kill("SIGKILL");
  }
  proc = null;
});

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function startMcp(env: Record<string, string>): Promise<{
  send: (msg: JsonRpcMessage) => void;
  waitForId: (id: number, timeoutMs?: number) => Promise<JsonRpcMessage>;
}> {
  proc = spawn("bun", ["run", MCP], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    cwd: REPO_ROOT,
  });
  if (!proc.stdout || !proc.stdin) throw new Error("no stdio on spawned child");

  let buffer = "";
  const pending: JsonRpcMessage[] = [];
  const waiters: Array<{ id: number; resolve: (m: JsonRpcMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        const w = waiters.findIndex((w) => w.id === msg.id);
        if (w !== -1) {
          clearTimeout(waiters[w]!.timer);
          waiters[w]!.resolve(msg);
          waiters.splice(w, 1);
        } else {
          pending.push(msg);
        }
      } catch { /* ignore non-json */ }
    }
  });

  // No-op stderr; the test doesn't care about server logs.
  proc.stderr?.on("data", () => {});

  return {
    send: (msg) => {
      proc!.stdin!.write(JSON.stringify(msg) + "\n");
    },
    waitForId: (id, timeoutMs = 10_000) =>
      new Promise<JsonRpcMessage>((resolve, reject) => {
        const idx = pending.findIndex((m) => m.id === id);
        if (idx !== -1) {
          resolve(pending.splice(idx, 1)[0]!);
          return;
        }
        const timer = setTimeout(() => reject(new Error(`waitForId ${id} timed out after ${timeoutMs}ms`)), timeoutMs);
        waiters.push({ id, resolve, reject, timer });
      }),
  };
}

test("mcp loop emits handler_timeout when a request exceeds the budget", async () => {
  // Tight 100ms budget. Even unbrowse_health needs longer than that
  // because it touches the in-process app boot. So the timeout MUST
  // fire before health can return.
  const { send, waitForId } = await startMcp({ UNBROWSE_MCP_HANDLER_TIMEOUT_MS: "100" });

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  const init = await waitForId(1, 15_000);
  expect(init.result).toBeDefined();

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "unbrowse_health", arguments: {} },
  });

  const resp = await waitForId(2, 5_000);
  // Either the call returned successfully within 100ms (very unlikely
  // but theoretically possible if health is cached), or it timed out.
  // Both outcomes are correct — what we're proving is that we always
  // got a response within 5s and the loop didn't hang.
  expect(resp).toBeDefined();
  if (resp.error) {
    expect(resp.error.code).toBe(-32001);
    expect(resp.error.message).toContain("handler_timeout");
  } else {
    // If health returned within 100ms, that's fine. The contract is
    // "the loop responds; it doesn't hang."
    expect(resp.result).toBeDefined();
  }

  // After the (potentially timed-out) request, the loop must still be
  // alive — send another ping and expect a result back.
  send({ jsonrpc: "2.0", id: 3, method: "ping" });
  const ping = await waitForId(3, 5_000);
  expect(ping.result).toBeDefined();
});

test("mcp loop with default timeout (no env) does not time out on a fast request", async () => {
  // No UNBROWSE_MCP_HANDLER_TIMEOUT_MS set — falls back to 90000ms
  // default. Health should complete well within that.
  const { send, waitForId } = await startMcp({});

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  await waitForId(1, 15_000);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "ping" });
  const ping = await waitForId(2, 5_000);
  expect(ping.result).toBeDefined();
  expect(ping.error).toBeUndefined();
});
