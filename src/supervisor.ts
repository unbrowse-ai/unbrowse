import { config as loadEnv } from "dotenv";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPackageRoot, runtimeInvocationForEntrypoint, resolveSiblingEntrypoint } from "./runtime/paths.js";

loadEnv({ quiet: true });
loadEnv({ path: ".env.runtime", quiet: true });

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 6969);
const baseUrl = process.env.UNBROWSE_URL ?? `http://${host}:${port}`;
const pidFile = process.env.UNBROWSE_PID_FILE;
const probeIntervalMs = Number(process.env.UNBROWSE_SUPERVISOR_PROBE_INTERVAL_MS ?? 5_000);
const probeTimeoutMs = Number(process.env.UNBROWSE_SUPERVISOR_PROBE_TIMEOUT_MS ?? 2_000);
const startupGraceMs = Number(process.env.UNBROWSE_SUPERVISOR_STARTUP_GRACE_MS ?? 20_000);
const unhealthyThreshold = Math.max(1, Number(process.env.UNBROWSE_SUPERVISOR_UNHEALTHY_THRESHOLD ?? 3));
const restartDelayMs = Math.max(0, Number(process.env.UNBROWSE_SUPERVISOR_RESTART_DELAY_MS ?? 1_000));

let child: ChildProcess | null = null;
let childStartedAt = 0;
let consecutiveProbeFailures = 0;
let shuttingDown = false;
let restartPromise: Promise<void> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeSupervisorPidFile(): void {
  if (!pidFile) return;
  try {
    mkdirSync(path.dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, JSON.stringify({
      pid: process.pid,
      ...(child?.pid ? { child_pid: child.pid } : {}),
      base_url: baseUrl,
      started_at: new Date().toISOString(),
      entrypoint: "supervisor",
    }, null, 2));
  } catch {
    // ignore pid-file failures
  }
}

function clearPidFile(): void {
  if (!pidFile) return;
  try {
    unlinkSync(pidFile);
  } catch {
    // ignore
  }
}

async function isHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(probeTimeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      proc.off("exit", onExit);
    };
    proc.once("exit", onExit);
  });
}

function spawnChild(): void {
  const entrypoint = resolveSiblingEntrypoint(import.meta.url, "index");
  const runtime = runtimeInvocationForEntrypoint(import.meta.url, entrypoint);
  const packageRoot = getPackageRoot(import.meta.url);

  child = spawn(runtime.command, runtime.args, {
    cwd: packageRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      UNBROWSE_URL: baseUrl,
      UNBROWSE_PID_FILE: "",
    },
  });
  childStartedAt = Date.now();
  consecutiveProbeFailures = 0;
  writeSupervisorPidFile();

  child.once("exit", () => {
    child = null;
    writeSupervisorPidFile();
    if (shuttingDown) return;
    void restartChild("child exited");
  });
}

async function stopChild(reason: string): Promise<void> {
  const current = child;
  if (!current) return;

  console.warn(`[supervisor] stopping child (${reason})`);
  try {
    current.kill("SIGTERM");
  } catch {
    // ignore
  }

  if (!(await waitForExit(current, 5_000))) {
    try {
      current.kill("SIGKILL");
    } catch {
      // ignore
    }
    await waitForExit(current, 2_000);
  }
}

async function restartChild(reason: string): Promise<void> {
  if (restartPromise) return restartPromise;
  restartPromise = (async () => {
    if (shuttingDown) return;
    await stopChild(reason);
    if (shuttingDown) return;
    if (restartDelayMs > 0) await sleep(restartDelayMs);
    if (shuttingDown) return;
    console.warn(`[supervisor] restarting child (${reason})`);
    spawnChild();
  })().finally(() => {
    restartPromise = null;
  });
  return restartPromise;
}

async function probeLoop(): Promise<void> {
  while (!shuttingDown) {
    await sleep(probeIntervalMs);
    if (shuttingDown || !child) continue;

    if (await isHealthy()) {
      consecutiveProbeFailures = 0;
      continue;
    }

    if (Date.now() - childStartedAt < startupGraceMs) continue;
    consecutiveProbeFailures += 1;
    if (consecutiveProbeFailures < unhealthyThreshold) continue;

    consecutiveProbeFailures = 0;
    await restartChild(`health probe failed ${unhealthyThreshold}x`);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`[supervisor] ${signal} — stopping child`);
  await stopChild(signal);
  clearPidFile();
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("exit", clearPidFile);

writeSupervisorPidFile();
spawnChild();
void probeLoop();
