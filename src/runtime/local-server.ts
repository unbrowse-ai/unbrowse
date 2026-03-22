import { openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, getPackageRoot, getServerAutostartLogFile, getServerPidFile, resolveSiblingEntrypoint, runtimeArgsForEntrypoint } from "./paths.js";
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

function deriveListenEnv(baseUrl: string): Record<string, string> {
  const url = new URL(baseUrl);
  const host = !url.hostname || url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return { HOST: host, PORT: port, UNBROWSE_URL: baseUrl };
}

export async function ensureLocalServer(baseUrl: string, noAutoStart: boolean, metaUrl: string): Promise<void> {
  const pidFile = getServerPidFile(baseUrl);
  let existing = readPidState(pidFile);
  const health = await getServerHealth(baseUrl);
  if (health.ok) {
    if (health.code_hash === CODE_HASH) return;

    // Only replace stale servers we started/manages via the pid file.
    if (existing?.pid && isPidAlive(existing.pid)) {
      await stopManagedServer(existing.pid, pidFile, baseUrl);
      existing = null;
    } else {
      if (existing) clearStalePidFile(pidFile);
      return;
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

  const entrypoint = resolveSiblingEntrypoint(metaUrl, "index");
  const packageRoot = getPackageRoot(metaUrl);
  const logFile = getServerAutostartLogFile();
  ensureDir(path.dirname(logFile));
  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, runtimeArgsForEntrypoint(metaUrl, entrypoint), {
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
}
