import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOG_DIR = path.join(os.homedir(), ".unbrowse", "logs");

function getLogFile(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `unbrowse-${date}.log`);
}

function ensureLogDir(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Log a message to both stdout and ~/.unbrowse/logs/unbrowse-YYYY-MM-DD.log.
 * Format: [HH:MM:SS] [module] message
 */
export function log(module: string, message: string): void {
  const ts = new Date().toTimeString().slice(0, 8); // HH:MM:SS
  const line = `[${ts}] [${module}] ${message}`;
  console.log(line);
  try {
    ensureLogDir();
    fs.appendFileSync(getLogFile(), line + "\n");
  } catch {
    // Never crash the main process if logging fails
  }
}

function tsMs(): string {
  // HH:MM:SS.mmm — millisecond precision for hang diagnosis
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function traceLine(message: string): void {
  const line = `[${tsMs()}] [trace] ${message}`;
  console.log(line);
  try {
    ensureLogDir();
    fs.appendFileSync(getLogFile(), line + "\n");
  } catch {
    // never crash on logging
  }
}

// Phase traces are diagnostic instrumentation, OFF by default — a new user (or any
// MCP host capturing stderr) should never see internal `[trace] phase=…` spam. Opt in
// with UNBROWSE_TRACE=1 (or any non-"0"/non-empty value) when debugging a hang.
const TRACE_ENABLED = (() => {
  const v = process.env.UNBROWSE_TRACE;
  return v != null && v !== "" && v !== "0";
})();
const TRACE_SLOW_MS = (() => {
  const n = parseInt(process.env.UNBROWSE_TRACE_SLOW_MS ?? "5000", 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
})();

/**
 * Bracket one awaited step with a BEGIN/END trace so a hang is diagnosable
 * from the log alone: a dangling BEGIN with no matching END names the exact
 * stuck await. While the step is pending, a SLOW heartbeat prints elapsed
 * every TRACE_SLOW_MS (UNBROWSE_TRACE_SLOW_MS, default 5000) so a live hang
 * is visible WITHOUT re-running and waiting. Pure instrumentation — no
 * behavior change, no timeout, no abort. Disable with UNBROWSE_TRACE=0.
 *
 * Format: [HH:MM:SS.mmm] [trace] sid=<8> scope=<s> phase=<p> BEGIN
 *         [HH:MM:SS.mmm] [trace] sid=<8> scope=<s> phase=<p> SLOW elapsed=<ms>ms
 *         [HH:MM:SS.mmm] [trace] sid=<8> scope=<s> phase=<p> END dur=<ms>ms
 *         [HH:MM:SS.mmm] [trace] sid=<8> scope=<s> phase=<p> THREW dur=<ms>ms err=<msg>
 */
export async function traceAsync<T>(
  scope: string,
  sid: string | undefined,
  phase: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!TRACE_ENABLED) return fn();
  const sidShort = (sid ?? "-").slice(0, 8);
  const tag = `sid=${sidShort} scope=${scope} phase=${phase}`;
  const start = Date.now();
  traceLine(`${tag} BEGIN`);
  const heartbeat = setInterval(() => {
    traceLine(`${tag} SLOW elapsed=${Date.now() - start}ms`);
  }, TRACE_SLOW_MS);
  // Never let the heartbeat keep the event loop alive on its own.
  (heartbeat as unknown as { unref?: () => void }).unref?.();
  try {
    const result = await fn();
    clearInterval(heartbeat);
    traceLine(`${tag} END dur=${Date.now() - start}ms`);
    return result;
  } catch (err) {
    clearInterval(heartbeat);
    const msg = err instanceof Error ? err.message : String(err);
    traceLine(`${tag} THREW dur=${Date.now() - start}ms err=${msg}`);
    throw err;
  }
}
