// Stateless MCP stdin-EOF gate.
//
// Older architecture auto-spawned a localhost HTTP daemon from MCP and then
// needed an EOF watcher to reap it. The stateless binary architecture removes
// that authority entirely: MCP serves tool calls through the in-process API and
// stdin EOF must leave no local server behind.

import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const MCP_ENTRY = resolve(REPO_ROOT, "src", "mcp.ts");

function pickPort(): number {
  return 16970 + Math.floor(Math.random() * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function portRefused(port: number): Promise<boolean> {
  return new Promise((resolveP) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (refused: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolveP(refused);
    };
    sock.once("connect", () => done(false));
    sock.once("error", () => done(true));
    setTimeout(() => done(true), 800);
  });
}

function send(child: ChildProcess, msg: unknown): void {
  child.stdin!.write(JSON.stringify(msg) + "\n");
}

describe("mcp stdin-EOF watcher", () => {
  test(
    "serves in-process and leaves no daemon after stdin EOF",
    async () => {
      const port = pickPort();
      const baseUrl = `http://127.0.0.1:${port}`;
      expect(await portRefused(port)).toBe(true);

      const proc = spawn("bun", [MCP_ENTRY], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          UNBROWSE_URL: baseUrl,
          UNBROWSE_NON_INTERACTIVE: "1",
          UNBROWSE_TOS_ACCEPTED: "1",
          MCP_SERVER_MODE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const responses: Array<{ id?: unknown; result?: unknown; error?: unknown }> = [];
      let stderr = "";
      proc.stderr.on("data", (b) => { stderr += b.toString(); });
      let buf = "";
      proc.stdout.on("data", (b) => {
        buf += b.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            responses.push(JSON.parse(line));
          } catch {
            // Ignore non-RPC noise; stdout is asserted through the response id.
          }
        }
      });

      try {
        send(proc, {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            clientInfo: { name: "test", version: "0" },
            capabilities: {},
          },
        });
        send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
        send(proc, {
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
          await sleep(100);
        }

        expect(health, `health response missing. stderr=${stderr.slice(-2000)}`).toBeDefined();
        expect(health!.error).toBeUndefined();
        expect(JSON.stringify(health!.result ?? {})).toMatch(/status|package_version|version|ok/i);
        expect(stderr).toContain("starting stateless stdio MCP");
        expect(await portRefused(port)).toBe(true);

        proc.stdin.end();
        await new Promise<void>((resolveP) => {
          const timer = setTimeout(() => {
            try { proc.kill("SIGKILL"); } catch {}
            resolveP();
          }, 8_000);
          proc.on("exit", () => {
            clearTimeout(timer);
            resolveP();
          });
        });

        expect(await portRefused(port)).toBe(true);
      } finally {
        try { proc.kill("SIGKILL"); } catch {}
      }
    },
    45_000,
  );
});
