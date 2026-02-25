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
