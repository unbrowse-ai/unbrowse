// Phase 2 Day-3 seed: stdin-EOF watcher in src/mcp.ts must stop the
// auto-spawned daemon when the parent IDE disconnects. Without it the
// daemon outlives the MCP process for ~60s (idle reaper) — the classic
// "stale unbrowse server" footgun.
//
// Real spawn, no mocks. Steers a unique port + isolated UNBROWSE_RUN_DIR
// so we don't fight any developer-local unbrowse server.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const MCP_ENTRY = path.join(REPO_ROOT, "src", "mcp.ts");

function pickPort(): number {
  // 16970–17970 range, dodge the default 6969.
  return 16970 + Math.floor(Math.random() * 1000);
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

describe("mcp stdin-EOF watcher", () => {
  let runDir: string;
  let port: number;
  let pidFile: string;

  beforeAll(() => {
    runDir = mkdtempSync(path.join(tmpdir(), "unbrowse-eof-"));
    port = pickPort();
    // Mirrors getServerPidFile(`http://127.0.0.1:<port>`).
    pidFile = path.join(runDir, `server-127.0.0.1-${port}.json`);
  });

  afterAll(() => {
    try {
      if (existsSync(pidFile)) {
        const state = JSON.parse(readFileSync(pidFile, "utf-8"));
        if (state.pid && pidAlive(state.pid)) {
          try { process.kill(state.pid, "SIGKILL"); } catch {}
        }
      }
      rmSync(runDir, { recursive: true, force: true });
    } catch {}
  });

  test(
    "closes auto-spawned daemon when stdin EOFs",
    async () => {
      const baseUrl = `http://127.0.0.1:${port}`;
      const env = {
        ...process.env,
        UNBROWSE_URL: baseUrl,
        UNBROWSE_RUN_DIR: runDir,
        UNBROWSE_NON_INTERACTIVE: "1",
        UNBROWSE_TOS_ACCEPTED: "1",
        MCP_SERVER_MODE: "1",
      };

      const proc = spawn("bun", [MCP_ENTRY], {
        cwd: REPO_ROOT,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      proc.stderr.on("data", (b) => { stderr += b.toString(); });
      let stdout = "";
      proc.stdout.on("data", (b) => { stdout += b.toString(); });

      try {
        // Drive ensureServerReady via initialize + a tools/list call.
        // ensureServerReady is gated on api() use, but initialize alone
        // doesn't trigger it; tools/list does (via the same gate).
        proc.stdin.write(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-11-25", clientInfo: { name: "test", version: "0" }, capabilities: {} },
        }) + "\n");
        proc.stdin.write(JSON.stringify({
          jsonrpc: "2.0", id: 2, method: "tools/list",
        }) + "\n");

        // Wait until pidfile exists and the daemon is alive.
        const state = await waitFor(() => {
          if (!existsSync(pidFile)) return null;
          try {
            const s = JSON.parse(readFileSync(pidFile, "utf-8"));
            if (s.pid && pidAlive(s.pid)) return s;
          } catch {}
          return null;
        }, 15_000);

        // If we never spawned, the test environment can't run the daemon
        // (network/binary issue). Surface that explicitly rather than
        // false-passing on an absent daemon.
        expect(state, `daemon never spawned within 15s. stderr=${stderr.slice(-2000)}`).not.toBeNull();
        const daemonPid: number = state!.pid;
        expect(pidAlive(daemonPid)).toBe(true);

        // Close stdin — this is the EOF signal the watcher must catch.
        proc.stdin.end();

        // Watcher uses force:true + timeoutMs:3_000; allow up to 5s.
        const stopped = await waitFor(() => (!pidAlive(daemonPid) ? true : null), 5_000);
        expect(
          stopped,
          `daemon pid ${daemonPid} still alive 5s after stdin close. stderr=${stderr.slice(-2000)}`,
        ).toBe(true);
      } finally {
        try { proc.kill("SIGKILL"); } catch {}
      }
    },
    20_000,
  );
});
