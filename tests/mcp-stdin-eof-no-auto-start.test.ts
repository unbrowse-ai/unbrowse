// Phase 2 Day-4 luminary — adversarial complement to mcp-stdin-eof.test.ts.
//
// The positive test proves: when MCP auto-spawns the daemon, closing stdin
// stops it. THIS test proves the negative: when --no-auto-start is set and a
// daemon is already running (someone else's), MCP must NOT kill it on stdin
// EOF. Worker B's report claims the spawn-detection branch in
// ensureServerReady (src/mcp.ts:591–596) gates `spawnedTheDaemon` on
// `!NO_AUTO_START`. If a future refactor bypasses that gate, MCP starts
// killing user-owned daemons. That's the lost sheep.
//
// Real two-process setup, no mocks.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const MCP_ENTRY = path.join(REPO_ROOT, "src", "mcp.ts");
const CLI_ENTRY = path.join(REPO_ROOT, "src", "cli.ts");

function pickPort(): number {
  // 17970–18970 range — distinct from the positive test's 16970–17970.
  return 17970 + Math.floor(Math.random() * 1000);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code !== "ESRCH";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  probe: () => T | null,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = probe();
    if (v) return v;
    await sleep(intervalMs);
  }
  return null;
}

describe("mcp stdin-EOF respects --no-auto-start", () => {
  let runDir: string;
  let port: number;
  let pidFile: string;
  let preExistingPid: number | null = null;

  beforeAll(() => {
    runDir = mkdtempSync(path.join(tmpdir(), "unbrowse-noauto-eof-"));
    port = pickPort();
    pidFile = path.join(runDir, `server-127.0.0.1-${port}.json`);
  });

  afterAll(() => {
    try {
      if (preExistingPid && pidAlive(preExistingPid)) {
        try { process.kill(preExistingPid, "SIGTERM"); } catch {}
        try { process.kill(preExistingPid, "SIGKILL"); } catch {}
      }
      if (existsSync(pidFile)) {
        try {
          const state = JSON.parse(readFileSync(pidFile, "utf-8"));
          if (state.pid && pidAlive(state.pid)) {
            try { process.kill(state.pid, "SIGKILL"); } catch {}
          }
        } catch {}
      }
      rmSync(runDir, { recursive: true, force: true });
    } catch {}
  });

  test(
    "pre-existing daemon survives MCP stdin close when --no-auto-start",
    async () => {
      const baseUrl = `http://127.0.0.1:${port}`;
      const env = {
        ...process.env,
        UNBROWSE_URL: baseUrl,
        UNBROWSE_RUN_DIR: runDir,
        UNBROWSE_NON_INTERACTIVE: "1",
        UNBROWSE_TOS_ACCEPTED: "1",
        PORT: String(port),
        UNBROWSE_PID_FILE: pidFile,
      };

      // Step 1: pre-spawn a daemon ourselves via `unbrowse serve`. This
      // simulates a user-owned daemon that MCP must not touch.
      const daemon = spawn("bun", [CLI_ENTRY, "serve"], {
        cwd: REPO_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      let daemonStderr = "";
      daemon.stderr?.on("data", (b) => { daemonStderr += b.toString(); });
      let daemonStdout = "";
      daemon.stdout?.on("data", (b) => { daemonStdout += b.toString(); });

      // Wait until pidfile shows up and the recorded pid is alive.
      const state = await waitFor(() => {
        if (!existsSync(pidFile)) return null;
        try {
          const s = JSON.parse(readFileSync(pidFile, "utf-8"));
          if (s.pid && pidAlive(s.pid)) return s;
        } catch {}
        return null;
      }, 15_000);

      expect(
        state,
        `pre-spawned daemon never came up within 15s. stderr=${daemonStderr.slice(-2000)} stdout=${daemonStdout.slice(-1000)}`,
      ).not.toBeNull();
      preExistingPid = state!.pid;
      expect(pidAlive(preExistingPid!)).toBe(true);

      // Step 2: spawn MCP WITH --no-auto-start. Drive a tools/list call so
      // ensureServerReady runs; with --no-auto-start it should detect the
      // pre-existing daemon and NOT set spawnedTheDaemon.
      const mcp = spawn("bun", [MCP_ENTRY, "--no-auto-start"], {
        cwd: REPO_ROOT,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let mcpStderr = "";
      mcp.stderr.on("data", (b) => { mcpStderr += b.toString(); });
      let mcpStdout = "";
      mcp.stdout.on("data", (b) => { mcpStdout += b.toString(); });

      try {
        mcp.stdin.write(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            clientInfo: { name: "test", version: "0" },
            capabilities: {},
          },
        }) + "\n");
        mcp.stdin.write(JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/list",
        }) + "\n");

        // Give MCP a moment to handle requests and resolve ensureServerReady.
        await sleep(2_000);

        // Close stdin — triggers the EOF watcher.
        mcp.stdin.end();

        // Wait for MCP to exit (it awaits onStdinClose then returns from main).
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try { mcp.kill("SIGKILL"); } catch {}
            resolve();
          }, 8_000);
          mcp.on("exit", () => { clearTimeout(timer); resolve(); });
        });

        // CRUCIAL: the pre-existing daemon is STILL alive.
        // If this fails, the --no-auto-start gate is broken.
        expect(
          pidAlive(preExistingPid!),
          `pre-existing daemon pid ${preExistingPid} was killed by MCP despite --no-auto-start. ` +
          `mcp.stderr=${mcpStderr.slice(-2000)}`,
        ).toBe(true);

        // Sanity: the pidfile should also still reference the same pid (MCP
        // must not have rewritten/cleared it).
        expect(existsSync(pidFile)).toBe(true);
        const stillThere = JSON.parse(readFileSync(pidFile, "utf-8"));
        expect(stillThere.pid).toBe(preExistingPid);
      } finally {
        try { mcp.kill("SIGKILL"); } catch {}
      }
    },
    45_000,
  );
});
