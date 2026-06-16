import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { CODE_HASH, PACKAGE_VERSION } from "../src/version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const spawned = new Set<Bun.Subprocess>();
const tempDirs: string[] = [];

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate free port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(baseUrl: string, predicate: (body: any) => boolean, timeoutMs = 20_000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) {
        const body = await res.json();
        if (predicate(body)) return body;
      }
    } catch {
      // keep polling
    }
    await Bun.sleep(250);
  }
  throw new Error(`health predicate was not satisfied for ${baseUrl}`);
}

function startStaleServer(port: number): Bun.Subprocess {
  const source = `
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: ${port},
  fetch(req) {
    const pathname = new URL(req.url).pathname;
    if (pathname === "/health") {
      return Response.json({
        status: "ok",
        package_version: "0.0.0-stale",
        code_hash: "stalehash123456",
        pid: process.pid,
      });
    }
    return Response.json({ stale: true });
  },
});
const stop = () => {
  Promise.resolve(server.stop(true)).finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 1 << 30);
`;
  const proc = Bun.spawn([process.execPath, "-e", source], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });
  spawned.add(proc);
  return proc;
}

async function runCliHealth(baseUrl: string, runDir: string): Promise<{ code: number; body: any; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "src/cli.ts", "eval", "status", "--pretty"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UNBROWSE_URL: baseUrl,
      UNBROWSE_RUN_DIR: runDir,
      UNBROWSE_NON_INTERACTIVE: "1",
      UNBROWSE_TOS_ACCEPTED: "1",
      UNBROWSE_DISABLE_AUTO_UPDATE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const body = JSON.parse(stdout.trim() || "{}");
  return { code, body, stderr };
}

function pidFileFor(runDir: string, port: number): string {
  return join(runDir, `server-127.0.0.1-${port}.json`);
}

async function stopPid(pid?: number): Promise<void> {
  if (!pid || pid === process.pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  await Bun.sleep(500);
  try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
}

afterEach(async () => {
  for (const proc of spawned) {
    if (proc.exitCode === null) proc.kill("SIGTERM");
  }
  await Promise.allSettled([...spawned].map((proc) => proc.exited));
  spawned.clear();

  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.startsWith("server-") || !file.endsWith(".json")) continue;
        try {
          const state = JSON.parse(readFileSync(join(dir, file), "utf-8")) as { pid?: number };
          await stopPid(state.pid);
        } catch {
          // best-effort cleanup
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("local server update refresh", () => {
  it("replaces a stale Unbrowse server discovered through /health pid metadata", async () => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const runDir = mkdtempSync(join(tmpdir(), "unbrowse-restart-"));
    tempDirs.push(runDir);
    const stale = startStaleServer(port);

    const staleHealth = await waitForHealth(baseUrl, (body) => body?.package_version === "0.0.0-stale");
    expect(staleHealth.pid).toBe(stale.pid);

    const result = await runCliHealth(baseUrl, runDir);
    expect(result.code).toBe(0);
    expect(result.body.package_version).toBe(PACKAGE_VERSION);
    expect(result.body.code_hash).toBe(CODE_HASH);
    expect(result.body.pid).not.toBe(stale.pid);

    const staleExited = await Promise.race([
      stale.exited.then(() => true),
      Bun.sleep(5_000).then(() => false),
    ]);
    expect(staleExited).toBe(true);

    const pidFile = pidFileFor(runDir, port);
    if (existsSync(pidFile)) {
      const state = JSON.parse(readFileSync(pidFile, "utf-8")) as { pid?: number };
      await stopPid(state.pid);
    }
  }, 60_000);
});
