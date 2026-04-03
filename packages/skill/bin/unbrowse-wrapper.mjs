#!/usr/bin/env node

/**
 * Thin wrapper — execs the compiled binary if available,
 * falls back to the package-managed Node launcher if not.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binaryPath = join(__dirname, "unbrowse");

if (existsSync(binaryPath)) {
  // Compiled binary — exec directly, replace this process
  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  });
} else {
  // Fallback: delegate to the stable package launcher so
  // npm installs and npx use the same dependency resolution path.
  const launcherPath = join(__dirname, "unbrowse.js");
  const child = spawn(process.execPath, [launcherPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  });
}
