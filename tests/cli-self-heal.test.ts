import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "path";
import net from "node:net";

const TESTS_DIR = dirname(new URL(import.meta.url).pathname);
const ROOT = join(TESTS_DIR, "..");

async function isServerUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs: number, baseUrl: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(baseUrl)) return;
    await Bun.sleep(250);
  }
  throw new Error(`server did not become healthy at ${baseUrl} within ${timeoutMs}ms`);
}

async function waitForServerDown(timeoutMs: number, baseUrl: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isServerUp(baseUrl))) return;
    await Bun.sleep(250);
  }
  throw new Error(`server stayed healthy at ${baseUrl} for ${timeoutMs}ms`);
}

async function runCli(args: string[], envOverrides: Record<string, string> = {}): Promise<{ code: number; body: any; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...envOverrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  let body: any;
  try {
    body = JSON.parse(stdout.trim() || "{}");
  } catch {
    throw new Error(`cli returned non-JSON stdout\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { code, body, stdout, stderr };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close((err) => err ? reject(err) : resolve(port));
    });
    server.on("error", reject);
  });
}

function pidFileFor(runDir: string, port: number): string {
  return join(runDir, `server-127.0.0.1-${port}.json`);
}

function readPidState(pidFile: string): { pid: number; child_pid?: number } {
  return JSON.parse(readFileSync(pidFile, "utf-8")) as { pid: number; child_pid?: number };
}

async function waitForChildPidChange(pidFile: string, previousChildPid: number, timeoutMs = 20_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const next = readPidState(pidFile).child_pid;
      if (typeof next === "number" && next > 0 && next !== previousChildPid) return next;
    } catch {
      // keep polling
    }
    await Bun.sleep(250);
  }
  throw new Error(`child pid did not change within ${timeoutMs}ms`);
}

describe("CLI self-heal", () => {
  it("recovers a wedged supervised child without manual restart", async () => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-run-"));
    const pidFile = pidFileFor(runDir, port);
    const env = {
      UNBROWSE_URL: baseUrl,
      UNBROWSE_RUN_DIR: runDir,
      UNBROWSE_DISABLE_AUTO_UPDATE: "1",
      UNBROWSE_SUPERVISOR_PROBE_INTERVAL_MS: "1000",
      UNBROWSE_SUPERVISOR_PROBE_TIMEOUT_MS: "200",
      UNBROWSE_SUPERVISOR_STARTUP_GRACE_MS: "4000",
      UNBROWSE_SUPERVISOR_UNHEALTHY_THRESHOLD: "2",
      UNBROWSE_SUPERVISOR_RESTART_DELAY_MS: "0",
    };

    try {
      const started = await runCli(["health"], env);
      expect(started.code).toBe(0);
      expect(started.body.status).toBe("ok");

      const state = readPidState(pidFile);
      expect(state.pid).toBeGreaterThan(0);
      expect(state.child_pid).toBeGreaterThan(0);

      const wedgedChildPid = state.child_pid!;
      process.kill(wedgedChildPid, "SIGSTOP");

      await waitForServerDown(10_000, baseUrl);
      const recoveredChildPid = await waitForChildPidChange(pidFile, wedgedChildPid);
      expect(recoveredChildPid).not.toBe(wedgedChildPid);
      await waitForServer(20_000, baseUrl);

      const recovered = await runCli(["health", "--no-auto-start"], env);
      expect(recovered.code).toBe(0);
      expect(recovered.body.status).toBe("ok");
      expect(readPidState(pidFile).child_pid).not.toBe(wedgedChildPid);
    } finally {
      try {
        process.kill(readPidState(pidFile).pid, "SIGTERM");
        await waitForServerDown(10_000, baseUrl);
      } catch {
        // best-effort cleanup
      }
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 45_000);
});
