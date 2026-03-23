import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { ensureDir, getPackageRoot, getServerAutostartLogFile, getServerPidFile, resolveSiblingEntrypoint, runtimeInvocationForEntrypoint } from "./paths.js";
import { CODE_HASH } from "../version.js";

type PidState = {
  pid: number;
  base_url: string;
  started_at: string;
  entrypoint: string;
};

type HealthState = {
  ok: boolean;
  code_hash?: string;
};

async function getServerHealth(baseUrl: string, timeoutMs = 2_000): Promise<HealthState> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false };
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return {
        ok: true,
        ...(typeof parsed.code_hash === "string" ? { code_hash: parsed.code_hash } : {}),
      };
    } catch {
      return { ok: true };
    }
  } catch {
    return { ok: false };
  }
}

async function isServerHealthy(baseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  return (await getServerHealth(baseUrl, timeoutMs)).ok;
}

async function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerHealthy(baseUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForServerDown(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isServerHealthy(baseUrl))) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidState(pidFile: string): PidState | null {
  try {
    return JSON.parse(readFileSync(pidFile, "utf-8")) as PidState;
  } catch {
    return null;
  }
}

function clearStalePidFile(pidFile: string): void {
  try {
    unlinkSync(pidFile);
  } catch {
    // ignore
  }
}

function findListeningPid(baseUrl: string): number | null {
  try {
    const url = new URL(baseUrl);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pid = Number(output.split(/\s+/).find(Boolean));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readProcessCommand(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function isLikelyUnbrowseServerProcess(pid: number): boolean {
  const command = readProcessCommand(pid);
  return /\bunbrowse\b|runtime-src\/index\.ts|src\/index\.ts|dist\/index\.js/i.test(command);
}

async function stopManagedServer(pid: number, pidFile: string, baseUrl: string): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    clearStalePidFile(pidFile);
    return;
  }

  if (!(await waitForServerDown(baseUrl, 5_000)) && isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
    await waitForServerDown(baseUrl, 2_000);
  }

  clearStalePidFile(pidFile);
}

function clearStaleStartupLockFile(lockFile: string): void {
  try {
    unlinkSync(lockFile);
  } catch {
    // ignore
  }
}

function isStartupLockStale(lockFile: string): boolean {
  try {
    const stats = statSync(lockFile);
    return Date.now() - stats.mtimeMs > 35_000;
  } catch {
    return true;
  }
}

function deriveListenEnv(baseUrl: string): Record<string, string> {
  const url = new URL(baseUrl);
  const host = !url.hostname || url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return { HOST: host, PORT: port, UNBROWSE_URL: baseUrl };
}

export async function ensureLocalServer(baseUrl: string, noAutoStart: boolean, metaUrl: string): Promise<void> {
  const pidFile = getServerPidFile(baseUrl);
  const startupLockFile = `${pidFile}.lock`;
  let existing = readPidState(pidFile);
  const health = await getServerHealth(baseUrl);
  if (health.ok) {
    if (health.code_hash === CODE_HASH) return;

    // Only replace stale servers we started/manage via the pid file.
    if (existing?.pid && isPidAlive(existing.pid)) {
      await stopManagedServer(existing.pid, pidFile, baseUrl);
      existing = null;
    } else {
      if (existing) clearStalePidFile(pidFile);
      const discoveredPid = findListeningPid(baseUrl);
      if (discoveredPid && isLikelyUnbrowseServerProcess(discoveredPid)) {
        await stopManagedServer(discoveredPid, pidFile, baseUrl);
        existing = null;
      } else {
        return;
      }
    }
  }

  if (existing?.pid && isPidAlive(existing.pid)) {
    if (await waitForHealthy(baseUrl, 15_000)) {
      const waitedHealth = await getServerHealth(baseUrl);
      if (waitedHealth.ok && waitedHealth.code_hash === CODE_HASH) return;
      await stopManagedServer(existing.pid, pidFile, baseUrl);
    }
  } else if (existing) {
    clearStalePidFile(pidFile);
  }

  if (noAutoStart) {
    throw new Error("Server not running and auto-start disabled (--no-auto-start).");
  }

  let startupLockFd: number | null = null;
  try {
    startupLockFd = openSync(startupLockFile, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (await waitForHealthy(baseUrl, 30_000)) return;
      const owner = readPidState(pidFile);
      const ownerAlive = owner?.pid ? isPidAlive(owner.pid) : false;
      if (!ownerAlive && isStartupLockStale(startupLockFile)) {
        clearStalePidFile(pidFile);
        clearStaleStartupLockFile(startupLockFile);
        return ensureLocalServer(baseUrl, noAutoStart, metaUrl);
      }
      throw new Error(`Server startup already in progress but did not become healthy. Check ${getServerAutostartLogFile()}`);
    }
    throw error;
  }

  try {
    if (await isServerHealthy(baseUrl)) return;

    const entrypoint = resolveSiblingEntrypoint(metaUrl, "index");
    const packageRoot = getPackageRoot(metaUrl);
    const logFile = getServerAutostartLogFile();
    ensureDir(path.dirname(logFile));
    const logFd = openSync(logFile, "a");
    const runtime = runtimeInvocationForEntrypoint(metaUrl, entrypoint);
    const child = spawn(runtime.command, runtime.args, {
      cwd: packageRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        ...deriveListenEnv(baseUrl),
        UNBROWSE_NON_INTERACTIVE: process.env.UNBROWSE_NON_INTERACTIVE || "1",
        ...(process.env.UNBROWSE_TOS_ACCEPTED ? { UNBROWSE_TOS_ACCEPTED: process.env.UNBROWSE_TOS_ACCEPTED } : {}),
        UNBROWSE_PID_FILE: pidFile,
      },
    });
    child.unref();

    writeFileSync(pidFile, JSON.stringify({
      pid: child.pid!,
      base_url: baseUrl,
      started_at: new Date().toISOString(),
      entrypoint,
    }, null, 2));

    if (await waitForHealthy(baseUrl, 30_000)) return;
    throw new Error(`Server failed to start. Check ${logFile}`);
  } finally {
    if (startupLockFd != null) {
      closeSync(startupLockFd);
      try {
        unlinkSync(startupLockFile);
      } catch {
        // ignore
      }
    }
  }
}
