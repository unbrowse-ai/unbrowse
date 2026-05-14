import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// Step 5 (Creatures) of Jesus Loop Phase 2 — verify MCP_SERVER_MODE tightens the
// idle-reaper default from 60s to 15s so MCP-spawned daemons don't linger when
// the stdin-EOF watcher fails (SIGKILL, crash).
//
// Tests spawn `bun` running an inline driver that calls startUnbrowseServer
// with onIdleExit -> process.exit(0). We measure wall-clock time to self-exit.
// Each spawn gets an isolated HOME so the reaper isn't suppressed by leftover
// rehydrated browse sessions in ~/.unbrowse/sessions.jsonl.

const REPO_ROOT = path.resolve(import.meta.dir, "..");

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("failed to allocate port"));
        return;
      }
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
    probe.on("error", reject);
  });
}

function buildDriver(port: number): string {
  return `
    import { startUnbrowseServer } from "${REPO_ROOT}/src/server.ts";
    // Tight check interval so reaper-tick latency doesn't smear the timing.
    process.env.UNBROWSE_SERVE_IDLE_CHECK_MS = "300";
    const server = await startUnbrowseServer({
      host: "127.0.0.1",
      port: ${port},
      logger: false,
      scheduleVerification: false,
      onIdleExit: () => process.exit(0),
    });
    process.stdout.write("LISTENING\\n");
  `;
}

interface SpawnResult {
  exitCode: number | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
}

async function spawnAndAwaitExit(
  envOverrides: Record<string, string | undefined>,
  port: number,
  timeoutMs: number,
): Promise<SpawnResult> {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "unbrowse-jl-test-"));
  const driver = buildDriver(port);

  // Build env: start from current process.env, then strip the keys we want to
  // unset (so the child sees them as absent, not as the literal string
  // "undefined"), then apply explicit overrides.
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.MCP_SERVER_MODE;
  delete env.UNBROWSE_SERVE_IDLE_MS;
  env.HOME = tmpHome;
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const child = spawn("bun", ["-e", driver], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b) => { stdout += b.toString(); });
  child.stderr.on("data", (b) => { stderr += b.toString(); });

  // Wait for LISTENING before starting the clock — server startup time
  // (Fastify boot + plugin load) varies and shouldn't count against idle.
  const listeningAt = await new Promise<number>((resolve, reject) => {
    const onData = () => {
      if (stdout.includes("LISTENING")) {
        child.stdout.off("data", onData);
        resolve(Date.now());
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`exited (code=${code}) before LISTENING: ${stderr || stdout}`)));
    setTimeout(() => reject(new Error("LISTENING timeout")), 15_000);
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process did not exit within ${timeoutMs}ms (stderr=${stderr})`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(killer);
      resolve(code);
    });
  });

  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }

  return { exitCode, elapsedMs: Date.now() - listeningAt, stdout, stderr };
}

describe("server idle reaper — MCP_SERVER_MODE default", () => {
  test("MCP_SERVER_MODE=1 with no override -> ~15s default", async () => {
    const port = await getFreePort();
    const res = await spawnAndAwaitExit(
      { MCP_SERVER_MODE: "1", UNBROWSE_SERVE_IDLE_MS: undefined },
      port,
      25_000,
    );
    expect(res.exitCode).toBe(0);
    // Idle window 15s + reaper tick (≤300ms) + Fastify close overhead.
    expect(res.elapsedMs).toBeGreaterThanOrEqual(14_500);
    expect(res.elapsedMs).toBeLessThanOrEqual(18_000);
  }, 30_000);

  test("MCP_SERVER_MODE=1 with explicit UNBROWSE_SERVE_IDLE_MS=2000 override", async () => {
    const port = await getFreePort();
    const res = await spawnAndAwaitExit(
      { MCP_SERVER_MODE: "1", UNBROWSE_SERVE_IDLE_MS: "2000" },
      port,
      8_000,
    );
    expect(res.exitCode).toBe(0);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(1_800);
    expect(res.elapsedMs).toBeLessThanOrEqual(4_000);
  }, 12_000);

  const slow = process.env.SLOW_TESTS === "1" ? test : test.skip;
  slow("no MCP_SERVER_MODE -> 60s default (slow; gated on SLOW_TESTS=1)", async () => {
    const port = await getFreePort();
    const res = await spawnAndAwaitExit(
      { MCP_SERVER_MODE: undefined, UNBROWSE_SERVE_IDLE_MS: undefined },
      port,
      75_000,
    );
    expect(res.exitCode).toBe(0);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(59_500);
    expect(res.elapsedMs).toBeLessThanOrEqual(65_000);
  }, 80_000);
});
