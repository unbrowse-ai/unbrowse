/**
 * Auto-update orchestrator — called from cli.ts on every invocation.
 * Checks if an update is due, then spawns a detached background worker.
 * Never blocks the CLI.
 */

import { lstatSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { homedir } from "os";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".unbrowse");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const SKILL_DIR = join(HOME, ".agents", "skills", "unbrowse");
const CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

/** Non-blocking auto-update check. Call at CLI startup — returns immediately. */
export function maybeAutoUpdate(): void {
  try {
    // Skip dev installs (symlinks to monorepo)
    if (lstatSync(SKILL_DIR).isSymbolicLink()) return;
  } catch {
    return; // skill dir doesn't exist
  }

  // Read config for last check timestamp
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch { /* fresh install, no config yet */ }

  const lastCheck = (config.last_update_check as number) || 0;
  if (Date.now() - lastCheck < CHECK_INTERVAL) return;

  // Update timestamp immediately to prevent concurrent checks
  config.last_update_check = Date.now();
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch { /* non-critical */ }

  // Spawn detached worker — CLI can exit without waiting
  const workerPath = join(SKILL_DIR, "src", "auto-update-worker.ts");
  const child = spawn("bun", [workerPath], {
    detached: true,
    stdio: "ignore",
    cwd: SKILL_DIR,
    env: { ...process.env },
  });
  child.unref();
}
