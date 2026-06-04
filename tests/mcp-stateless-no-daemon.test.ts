// Phase 0d gate: the stdio MCP serves tool calls in-process with NO
// :6969 HTTP daemon. Real-runtime, no mocks: spawns `bun src/mcp.ts`,
// drives JSON-RPC over stdio, asserts unbrowse_health returns real data
// AND nothing is ever listening on :6969 (proof the MCP did not spawn a
// daemon). Pre-Phase-0d this FAILED: the old code auto-spawned the
// Fastify daemon on 6969, so the port-refused assertion was false.

import { test, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

const MCP_ENTRY = path.join(import.meta.dir, "..", "src", "mcp.ts");

function portRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (refused: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(refused);
    };
    sock.once("connect", () => done(false));
    sock.once("error", () => done(true));
    setTimeout(() => done(true), 800);
  });
}

function send(child: ChildProcess, msg: unknown): void {
  child.stdin!.write(JSON.stringify(msg) + "\n");
}

test(
  "stdio MCP serves unbrowse_health in-process with no :6969 daemon",
  async () => {
    // Precondition: nothing on 6969. If a stray daemon is up the test is
    // invalid (loud, not silently green) per the stale-daemon footgun.
    expect(await portRefused(6969)).toBe(true);

    const child = spawn("bun", [MCP_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, UNBROWSE_NON_INTERACTIVE: "1" },
    });

    const responses: Array<{ id?: unknown; result?: unknown; error?: unknown }> = [];
    // Drain stderr or the child deadlocks: its telemetry/rehydrate logs
    // fill the 64KB stderr pipe buffer and block the process before it
    // can write the tools/call response to stdout.
    child.stderr!.on("data", () => {});
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try {
            responses.push(JSON.parse(line));
          } catch {
            /* non-JSON stderr-ish line on stdout: ignore */
          }
        }
      }
    });

    try {
      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "stateless-test", version: "0" },
        },
      });
      // MCP lifecycle: client must send notifications/initialized before
      // the server processes tools/call.
      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      send(child, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "unbrowse_health", arguments: {} },
      });

      const start = Date.now();
      let health: { id?: unknown; result?: unknown; error?: unknown } | undefined;
      while (Date.now() - start < 30_000) {
        health = responses.find((r) => r.id === 2);
        if (health) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      expect(health).toBeDefined();
      expect(health!.error).toBeUndefined();
      // Health must carry real runtime data (proves api() reached the
      // in-process route, not an empty/error envelope).
      const txt = JSON.stringify(health!.result ?? {});
      expect(txt).toMatch(/status|package_version|version|ok/i);

      // Core stateless assertion: the MCP spawned NO daemon. app.inject()
      // is in-memory; nothing binds 6969.
      expect(await portRefused(6969)).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  },
  45_000,
);
