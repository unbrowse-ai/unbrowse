import { openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, getPackageRoot, getServerAutostartLogFile, getServerPidFile, resolveSiblingEntrypoint, runtimeArgsForEntrypoint } from "./paths.js";
import { LocalSupervisor } from "./supervisor.js";

type PidState = {
  pid: number;
  base_url: string;
  started_at: string;
  entrypoint: string;
  version?: string;
  restart_count?: number;
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

/** Read package version from the nearest package.json. */
function getVersion(metaUrl: string): string {
  try {
    const root = getPackageRoot(metaUrl);
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function isCompiledBinary(): boolean {
  return !!(process.versions.bun && !process.argv[1]?.match(/\.(ts|js|mjs)$/));
}

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = 2_000;

/**
 * Spawn the local server as a detached child process.
 * Returns the PidState written to the pid file.
 */
function spawnServer(
  baseUrl: string,
  metaUrl: string,
  pidFile: string,
  restartCount = 0,
): PidState {
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

  const state: PidState = {
    pid: child.pid!,
    base_url: baseUrl,
    started_at: new Date().toISOString(),
    entrypoint,
    version: getVersion(metaUrl),
    restart_count: restartCount,
  };
  writeFileSync(pidFile, JSON.stringify(state, null, 2));
  return state;
}

/** Shared supervisor instance used for health checking. */
const supervisor = new LocalSupervisor();

export { supervisor };

export async function ensureLocalServer(baseUrl: string, noAutoStart: boolean, metaUrl: string): Promise<void> {
  if (await isServerHealthy(baseUrl)) {
    // Server already healthy — ensure supervisor state reflects this
    if (!supervisor.isRunning()) await supervisor.start();
    return;
  }

  const pidFile = getServerPidFile(baseUrl);
  const existing = readPidState(pidFile);

  if (existing?.pid && isPidAlive(existing.pid)) {
    // Process alive but not healthy — wait then try supervisor restart
    if (await waitForHealthy(baseUrl, 15_000)) {
      if (!supervisor.isRunning()) await supervisor.start();
      return;
    }
    // Still unhealthy after wait — kill stale process and restart
    try { process.kill(existing.pid, "SIGTERM"); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1_000));
    clearStalePidFile(pidFile);
    if (supervisor.isRunning()) await supervisor.stop();
  } else if (existing) {
    clearStalePidFile(pidFile);
  }

  if (noAutoStart) {
    throw new Error("Server not running and auto-start disabled (--no-auto-start).");
  }

  // Single-binary mode: start server inline instead of spawning a child
  if (isCompiledBinary()) {
    const { startUnbrowseServer, installServerExitCleanup } = await import("../server.js");
    installServerExitCleanup(pidFile);
    const server = await startUnbrowseServer({ pidFile, scheduleVerification: true });
    console.log(`[unbrowse] server started inline on http://${server.host}:${server.port}`);
    await supervisor.start();
    return;
  }

  // Spawn with supervisor retry
  for (let attempt = 0; attempt <= MAX_RESTART_ATTEMPTS; attempt++) {
    spawnServer(baseUrl, metaUrl, pidFile, attempt);

    if (await waitForHealthy(baseUrl, 30_000)) {
      await supervisor.start();
      return;
    }

    // Failed to start — clear and retry with backoff
    const state = readPidState(pidFile);
    if (state?.pid) {
      try { process.kill(state.pid, "SIGTERM"); } catch { /* ignore */ }
    }
    clearStalePidFile(pidFile);

    if (attempt < MAX_RESTART_ATTEMPTS) {
      const backoff = RESTART_BACKOFF_MS * (attempt + 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  const logFile = getServerAutostartLogFile();
  throw new Error(`Server failed to start after ${MAX_RESTART_ATTEMPTS + 1} attempts. Check ${logFile}`);
}

/**
 * Check if the running server version matches the installed CLI version.
 * Returns null if no server is running, or { running, installed, needs_restart }.
 */
export function checkServerVersion(baseUrl: string, metaUrl: string): { running: string; installed: string; needs_restart: boolean } | null {
  const pidFile = getServerPidFile(baseUrl);
  const state = readPidState(pidFile);
  if (!state) return null;
  const installed = getVersion(metaUrl);
  return {
    running: state.version ?? "unknown",
    installed,
    needs_restart: state.version !== installed,
  };
}

/**
 * Stop the running server gracefully.
 * Returns true if a server was stopped, false if none was running.
 */
export function stopServer(baseUrl: string): boolean {
  const pidFile = getServerPidFile(baseUrl);
  const state = readPidState(pidFile);
  if (!state?.pid) return false;
  try {
    process.kill(state.pid, "SIGTERM");
    clearStalePidFile(pidFile);
    // Synchronously mark supervisor as stopped (fire-and-forget the async stop)
    if (supervisor.isRunning()) void supervisor.stop();
    return true;
  } catch {
    clearStalePidFile(pidFile);
    return false;
  }
}

/**
 * Restart the local server (stop + start).
 * Used after CLI upgrades to pick up new code.
 */
export async function restartServer(baseUrl: string, metaUrl: string): Promise<void> {
  stopServer(baseUrl);
  await new Promise((r) => setTimeout(r, 1_000));
  await ensureLocalServer(baseUrl, false, metaUrl);
}
