// Phase 2 Day-5 creature — daemon self-reaps via MCP-mode 15s idle window
// when MCP is killed ungracefully (no stdin-EOF watcher firing).
import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("MCP-spawned daemon idle cascade", () => {
  test("daemon self-reaps via 15s MCP-mode idle window after SIGKILL", async () => {
    const home = await mkdtemp(join(tmpdir(), "p2-cascade-"));
    const port = 17500 + Math.floor(Math.random() * 400);
    const baseUrl = `http://127.0.0.1:${port}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PORT: String(port),
      UNBROWSE_URL: baseUrl,
      UNBROWSE_PID_FILE: join(home, "pidfile"),
      // Tighten the reaper check interval so we don't wait the default 10s
      // for the first check after the idle window opens.
      UNBROWSE_SERVE_IDLE_CHECK_MS: "1000",
    };
    // Let the MCP_SERVER_MODE=1 default (15_000) win.
    delete env.UNBROWSE_SERVE_IDLE_MS;

    const mcp = spawn("bun", ["src/mcp.ts"], {
      cwd: REPO_ROOT, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    mcp.stderr!.on("data", (b) => { stderr += b.toString(); });

    try {
      // Drive ensureServerReady. initialize alone won't trigger spawn; tools/list does.
      mcp.stdin!.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "p2-cascade", version: "0" } },
      }) + "\n");
      mcp.stdin!.write(JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
      }) + "\n");

      const start = Date.now();
      let up = false;
      while (Date.now() - start < 15_000) {
        const res = await fetch(`${baseUrl}/health`).catch(() => null);
        if (res && res.ok) { up = true; break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(up, `daemon never came up. stderr=${stderr.slice(-1500)}`).toBe(true);

      // Ungraceful kill — skips the stdin-EOF watcher entirely. From this
      // moment, the daemon has no incoming traffic; lastActivityTs is frozen.
      const killTs = Date.now();
      mcp.kill("SIGKILL");
      await new Promise<void>((resolve) => mcp.on("exit", () => resolve()));

      // Wait quietly without polling /health — every /health touches
      // lastActivityTs in the daemon and would defer the reaper forever.
      // Sleep 17s (15s idle window + ~2s for first 1s-interval check),
      // then probe once.
      await new Promise((r) => setTimeout(r, 17_000));

      const res = await fetch(`${baseUrl}/health`).catch(() => null);
      const elapsed = Date.now() - killTs;
      const dead = res === null;
      console.log(`[p2-cascade] elapsed=${elapsed}ms dead=${dead} status=${res?.status ?? "no-response"}`);

      expect(dead, `daemon still alive ${elapsed}ms after MCP SIGKILL; reaper did not fire (MCP_SERVER_MODE idle window not in effect?)`).toBe(true);
      // Sanity bounds on elapsed: must be in the 15-20s window the test sleep
      // dictates. Anything outside means the test plumbing is off, not the
      // reaper.
      expect(elapsed).toBeGreaterThan(15_000);
      expect(elapsed).toBeLessThan(22_000);
    } finally {
      try { mcp.kill("SIGKILL"); } catch {}
      await rm(home, { recursive: true, force: true });
    }
  }, 45_000);
});
