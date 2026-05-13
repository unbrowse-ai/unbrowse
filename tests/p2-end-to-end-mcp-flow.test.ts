// Phase 2 Day-6 dominion — end-to-end integration probe across CLI/MCP/daemon.
// Simulates a real Claude Code IDE session: spawn MCP, the MCP daemon comes
// up via auto-spawn after a real tool call, then stdin closes and the daemon
// should die fast via the stdin-EOF watcher (not the slow idle reaper).
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = "/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse-jl-default";

describe("Phase 2 end-to-end MCP flow", () => {
  test("MCP -> auto-spawn daemon -> tool call -> stdin close -> daemon dies fast", async () => {
    const home = await mkdtemp(join(tmpdir(), "p2-e2e-"));
    const port = 18000 + Math.floor(Math.random() * 500);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      UNBROWSE_URL: `http://127.0.0.1:${port}`,
      UNBROWSE_PID_FILE: join(home, "pidfile"),
    };
    delete env.UNBROWSE_NO_SWEEP;

    const mcp = spawn(process.execPath, ["src/mcp.ts"], {
      cwd: REPO_ROOT, env, stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    mcp.stdout?.on("data", (d) => (stdout += d.toString()));
    mcp.stderr?.on("data", (d) => (stderr += d.toString()));

    try {
      // Step 1: MCP initialize handshake.
      mcp.stdin?.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "p2-e2e", version: "0" } },
      }) + "\n");
      mcp.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      // Step 1b: real tool call — ensureServerReady only fires inside tool
      // handlers, so initialize/tools-list alone won't spawn the daemon.
      mcp.stdin?.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "unbrowse_health", arguments: {} },
      }) + "\n");

      // Step 2: wait for daemon to come up via auto-spawn. Poll /health.
      const start = Date.now();
      let daemonUp = false;
      while (Date.now() - start < 8000) {
        const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
        if (res && res.ok) { daemonUp = true; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(daemonUp).toBe(true);

      // Step 3: close stdin to trigger the EOF watcher.
      mcp.stdin?.end();

      // Step 4: wait for MCP to exit.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { mcp.kill("SIGKILL"); resolve(); }, 5000);
        mcp.on("exit", () => { clearTimeout(timer); resolve(); });
      });

      // Step 5: verify daemon is dead. Should be FAST (stopManagedServer is
      // an active stop with 3s timeout, not the 15s idle window). Allow 6s.
      const t0 = Date.now();
      let daemonDead = false;
      while (Date.now() - t0 < 6000) {
        const res = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
        if (!res) { daemonDead = true; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      const elapsed = Date.now() - t0;

      expect(daemonDead).toBe(true);
      expect(elapsed).toBeLessThan(6000);
    } finally {
      try { mcp.kill("SIGKILL"); } catch {}
      await rm(home, { recursive: true, force: true });
    }
  }, 25_000);
});
