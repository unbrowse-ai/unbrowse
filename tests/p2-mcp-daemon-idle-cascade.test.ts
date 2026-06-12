// Stateless MCP crash cascade.
//
// Pre-stateless MCP spawned a daemon and relied on a 15s idle reaper if the
// MCP process was killed. The current architecture removes that daemon. This
// test preserves the crash-path coverage by proving an ungraceful MCP SIGKILL
// leaves no listening local server and no managed pidfile.

import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

function pickPort(): number {
  return 17500 + Math.floor(Math.random() * 400);
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

describe("MCP-spawned daemon idle cascade", () => {
  test("MCP SIGKILL leaves no daemon because stdio MCP is stateless", async () => {
    const home = await mkdtemp(join(tmpdir(), "p2-cascade-"));
    const port = pickPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const pidFile = join(home, "pidfile");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PORT: String(port),
      UNBROWSE_URL: baseUrl,
      UNBROWSE_PID_FILE: pidFile,
      UNBROWSE_NON_INTERACTIVE: "1",
      UNBROWSE_TOS_ACCEPTED: "1",
    };

    expect(await portRefused(port)).toBe(true);

    const mcp = spawn("bun", ["src/mcp.ts"], {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses: Array<{ id?: unknown; result?: unknown; error?: unknown }> = [];
    let stderr = "";
    mcp.stderr!.on("data", (b) => { stderr += b.toString(); });
    let buf = "";
    mcp.stdout!.on("data", (b) => {
      buf += b.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {}
      }
    });

    try {
      send(mcp, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "p2-cascade", version: "0" },
        },
      });
      send(mcp, { jsonrpc: "2.0", method: "notifications/initialized" });
      send(mcp, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "unbrowse_health", arguments: {} },
      });

      const start = Date.now();
      while (Date.now() - start < 30_000 && !responses.find((r) => r.id === 2)) {
        await sleep(100);
      }
      const health = responses.find((r) => r.id === 2);
      expect(health, `health response missing. stderr=${stderr.slice(-1500)}`).toBeDefined();
      expect(health!.error).toBeUndefined();
      expect(stderr).toContain("starting stateless stdio MCP");
      expect(await portRefused(port)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);

      mcp.kill("SIGKILL");
      await new Promise<void>((resolveP) => mcp.on("exit", () => resolveP()));

      expect(await portRefused(port)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      try { mcp.kill("SIGKILL"); } catch {}
      await rm(home, { recursive: true, force: true });
    }
  }, 45_000);
});
