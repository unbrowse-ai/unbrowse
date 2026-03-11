import { openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, getPackageRoot, getServerAutostartLogFile, getServerPidFile, resolveSiblingEntrypoint, runtimeArgsForEntrypoint } from "./paths.js";

type PidState = {
  pid: number;
  base_url: string;
  started_at: string;
  entrypoint: string;
};

async function isServerHealthy(baseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerHealthy(baseUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
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

function deriveListenEnv(baseUrl: string): Record<string, string> {
  const url = new URL(baseUrl);
  const host = !url.hostname || url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return { HOST: host, PORT: port, UNBROWSE_URL: baseUrl };
}

export async function ensureLocalServer(baseUrl: string, noAutoStart: boolean, metaUrl: string): Promise<void> {
  if (await isServerHealthy(baseUrl)) return;

  const pidFile = getServerPidFile(baseUrl);
  const existing = readPidState(pidFile);
  if (existing?.pid && isPidAlive(existing.pid)) {
    if (await waitForHealthy(baseUrl, 15_000)) return;
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
      UNBROWSE_TOS_ACCEPTED: process.env.UNBROWSE_TOS_ACCEPTED || "1",
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
