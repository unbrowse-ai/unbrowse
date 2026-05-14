import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, getPackageRoot, getServerAutostartLogFile, getServerPidFile, resolveSiblingEntrypoint, runtimeArgsForEntrypoint } from "./paths.js";
import { LocalSupervisor } from "./supervisor.js";
import { CODE_HASH, PACKAGE_VERSION } from "../version.js";

type PidState = {
  pid: number;
  base_url: string;
  started_at: string;
  entrypoint: string;
  version?: string;
  code_hash?: string;
  restart_count?: number;
};

type ServerHealth = {
  status?: string;
  package_version?: string;
  code_hash?: string;
  pid?: number;
};

export function isServerVersionMismatch(
  runningVersion: string | undefined,
  installedVersion: string,
  runningCodeHash?: string,
  installedCodeHash?: string,
): boolean {
  return (!!runningVersion && runningVersion !== installedVersion)
    || (!!runningCodeHash && !!installedCodeHash && runningCodeHash !== installedCodeHash);
}

async function fetchServerHealth(baseUrl: string, timeoutMs = 2_000): Promise<ServerHealth | null> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json() as ServerHealth;
  } catch {
    return null;
  }
}

async function isServerHealthy(baseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  return !!(await fetchServerHealth(baseUrl, timeoutMs));
}

async function waitForHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerHealthy(baseUrl)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function waitForDown(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isServerHealthy(baseUrl, 500))) return true;
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

function validPid(value: unknown): number | null {
  return typeof value === "number"
    && Number.isInteger(value)
    && value > 0
    && value !== process.pid
    ? value
    : null;
}

function healthLooksLikeUnbrowseRuntime(health?: ServerHealth | null): boolean {
  return !!health
    && health.status === "ok"
    && (typeof health.package_version === "string" || typeof health.code_hash === "string");
}

export function getManagedServerPid(baseUrl: string, health?: ServerHealth | null): number | null {
  const healthPid = validPid(health?.pid);
  if (healthPid && healthLooksLikeUnbrowseRuntime(health)) return healthPid;

  const pidFile = getServerPidFile(baseUrl);
  const state = readPidState(pidFile);
  const statePid = validPid(state?.pid);
  if (statePid && isPidAlive(statePid)) return statePid;

  return null;
}

// Returns free / owned / foreign for the port in baseUrl, so ensureLocalServer can fast-fail on foreign holders.
export async function probePortOwnership(
  baseUrl: string,
): Promise<
  | { kind: "free" }
  | { kind: "owned"; pid: number }
  | { kind: "foreign"; pid: number | null }
> {
  let port: number;
  let host: string;
  try {
    const u = new URL(baseUrl);
    port = parseInt(u.port || "80", 10);
    host = u.hostname || "127.0.0.1";
  } catch {
    return { kind: "foreign", pid: null };
  }
  if (!Number.isFinite(port) || port <= 0) {
    return { kind: "foreign", pid: null };
  }

  // Attempt to bind; if EADDRINUSE the port is held.
  const bindError: NodeJS.ErrnoException | null = await new Promise((resolve) => {
    const probeServer = net.createServer();
    probeServer.once("error", (err: NodeJS.ErrnoException) => {
      try { probeServer.close(); } catch { /* ignore */ }
      resolve(err);
    });
    probeServer.once("listening", () => {
      probeServer.close(() => resolve(null));
    });
    probeServer.listen(port, host);
  });

  if (bindError === null) return { kind: "free" };
  if (bindError.code !== "EADDRINUSE") {
    // Other bind error (EACCES, EADDRNOTAVAIL). Treat as foreign-blocked.
    return { kind: "foreign", pid: null };
  }

  // Port is held. Distinguish owned vs foreign by asking the runtime who's there.
  const ownedPid = getManagedServerPid(baseUrl);
  if (ownedPid && isPidAlive(ownedPid)) {
    return { kind: "owned", pid: ownedPid };
  }
  // We have no managed PID for this port: foreign process.
  return { kind: "foreign", pid: null };
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

export async function stopManagedServer(
  baseUrl: string,
  health?: ServerHealth | null,
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<boolean> {
  const pidFile = getServerPidFile(baseUrl);
  const runtimeHealth = health ?? await fetchServerHealth(baseUrl, 500);
  const pid = getManagedServerPid(baseUrl, runtimeHealth);
  if (!pid) {
    clearStalePidFile(pidFile);
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    clearStalePidFile(pidFile);
    return await waitForDown(baseUrl, options.timeoutMs ?? 1_000);
  }

  clearStalePidFile(pidFile);
  if (supervisor.isRunning()) await supervisor.stop();

  const timeoutMs = options.timeoutMs ?? 5_000;
  if (await waitForDown(baseUrl, timeoutMs)) return true;

  if (options.force && isPidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    return await waitForDown(baseUrl, timeoutMs);
  }

  return false;
}

function deriveListenEnv(baseUrl: string): Record<string, string> {
  const url = new URL(baseUrl);
  const host = !url.hostname || url.hostname === "localhost" ? "127.0.0.1" : url.hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return { HOST: host, PORT: port, UNBROWSE_URL: baseUrl };
}

function isCompiledBinary(): boolean {
  return !!(process.versions.bun && !process.argv[1]?.match(/\.(ts|js|mjs)$/));
}

export function getServerSpawnSpec(metaUrl: string, entrypoint = resolveSiblingEntrypoint(metaUrl, "index")): {
  command: string;
  args: string[];
  cwd: string;
  recordedEntrypoint: string;
} {
  if (isCompiledBinary()) {
    return {
      command: process.execPath,
      args: ["serve"],
      cwd: process.cwd(),
      recordedEntrypoint: `${process.execPath} serve`,
    };
  }

  // Prefer bun-built dist/server.js over the index.js tsx wrapper
  const serverJs = path.join(path.dirname(entrypoint), "server.js");
  if (existsSync(serverJs) && path.basename(entrypoint) !== "server.js") {
    entrypoint = serverJs;
  }

  return {
    command: process.execPath,
    args: runtimeArgsForEntrypoint(metaUrl, entrypoint),
    cwd: getPackageRoot(metaUrl),
    recordedEntrypoint: entrypoint,
  };
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
  const spawnSpec = getServerSpawnSpec(metaUrl, entrypoint);
  const logFile = getServerAutostartLogFile();
  ensureDir(path.dirname(logFile));
  const logFd = openSync(logFile, "a");
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: spawnSpec.cwd,
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
    entrypoint: spawnSpec.recordedEntrypoint,
    version: PACKAGE_VERSION,
    code_hash: CODE_HASH,
    restart_count: restartCount,
  };
  writeFileSync(pidFile, JSON.stringify(state, null, 2));
  return state;
}

/** Shared supervisor instance used for health checking. */
const supervisor = new LocalSupervisor();

export { supervisor };

export async function ensureLocalServer(baseUrl: string, noAutoStart: boolean, metaUrl: string): Promise<void> {
  const installedVersion = PACKAGE_VERSION;
  const initialHealth = await fetchServerHealth(baseUrl);
  if (initialHealth) {
    const runningVersion = initialHealth.package_version;
    const runningCodeHash = initialHealth.code_hash;
    if (isServerVersionMismatch(runningVersion, installedVersion, runningCodeHash, CODE_HASH)) {
      const versionInfo = checkServerVersion(baseUrl, metaUrl, {
        runningVersion,
        runningCodeHash,
      });
      if (versionInfo?.needs_restart || getManagedServerPid(baseUrl, initialHealth)) {
        const stopped = await stopManagedServer(baseUrl, initialHealth, { force: true, timeoutMs: 5_000 });
        if (!stopped) {
          throw new Error(
            `Server runtime mismatch on ${baseUrl}: running ${runningVersion ?? "unknown"} (${runningCodeHash ?? "unknown"}), installed ${installedVersion} (${CODE_HASH}), but the stale local server did not stop. Run "unbrowse restart" or stop the stale server bound to that port.`,
          );
        }
      } else {
        throw new Error(
          `Server runtime mismatch on ${baseUrl}: running ${runningVersion ?? "unknown"} (${runningCodeHash ?? "unknown"}), installed ${installedVersion} (${CODE_HASH}), but Unbrowse could not identify an owned server pid. Run "unbrowse restart" or stop the stale server bound to that port.`,
        );
      }
    } else {
    // Server already healthy — ensure supervisor state reflects this
      if (!supervisor.isRunning()) await supervisor.start();
      return;
    }
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

  // B1: fast-fail before spawn-retry if a foreign process holds the port.
  const ownership = await probePortOwnership(baseUrl);
  if (ownership.kind === "foreign") {
    const pidHint = ownership.pid ? ` (pid=${ownership.pid})` : "";
    throw new Error(
      `Port for ${baseUrl} is held by a foreign process${pidHint}, ` +
      `not a managed unbrowse server. Run \`lsof -i :${new URL(baseUrl).port || "80"}\` ` +
      "to identify the holder, then `pkill -9 -f 'unbrowse|kuri'; sleep 2` " +
      "or stop the holder by hand. Refusing to spawn-retry into the same wall.",
    );
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
 * Returns null if no server is running, or runtime/version details.
 */
export function checkServerVersion(
  baseUrl: string,
  metaUrl: string,
): {
  running: string;
  installed: string;
  running_code_hash?: string;
  installed_code_hash: string;
  needs_restart: boolean;
} | null;
export function checkServerVersion(
  baseUrl: string,
  metaUrl: string,
  healthOverride: {
    runningVersion?: string;
    runningCodeHash?: string;
  },
): {
  running: string;
  installed: string;
  running_code_hash?: string;
  installed_code_hash: string;
  needs_restart: boolean;
} | null;
export function checkServerVersion(
  baseUrl: string,
  metaUrl: string,
  healthOverride?: {
    runningVersion?: string;
    runningCodeHash?: string;
  },
): {
  running: string;
  installed: string;
  running_code_hash?: string;
  installed_code_hash: string;
  needs_restart: boolean;
} | null {
  const pidFile = getServerPidFile(baseUrl);
  const state = readPidState(pidFile);
  if (!state) return null;
  const installed = PACKAGE_VERSION;
  const running = healthOverride?.runningVersion ?? state.version ?? "unknown";
  const runningCodeHash = healthOverride?.runningCodeHash ?? state.code_hash;
  return {
    running,
    installed,
    ...(runningCodeHash ? { running_code_hash: runningCodeHash } : {}),
    installed_code_hash: CODE_HASH,
    needs_restart: isServerVersionMismatch(running, installed, runningCodeHash, CODE_HASH),
  };
}

/**
 * Stop the running server gracefully.
 * Returns true if a server was stopped, false if none was running.
 */
export function stopServer(baseUrl: string): boolean {
  const pidFile = getServerPidFile(baseUrl);
  const state = readPidState(pidFile);
  const pid = validPid(state?.pid);
  if (!pid) {
    clearStalePidFile(pidFile);
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
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
  await stopManagedServer(baseUrl, undefined, { force: true, timeoutMs: 5_000 });
  await ensureLocalServer(baseUrl, false, metaUrl);
}
