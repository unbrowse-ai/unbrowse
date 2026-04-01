#!/usr/bin/env node

/**
 * Thin wrapper — execs the compiled binary if available,
 * falls back to source mode (bun/tsx) if not.
 */

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

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
  // Fallback: source mode via bun or tsx
  const packageRoot = join(__dirname, "..");
  const entry = join(packageRoot, "runtime-src", "cli.ts");
  
  // Try bun first, then node+tsx
  try {
    execFileSync("which", ["bun"], { stdio: "ignore" });
    const child = spawn("bun", [entry, ...process.argv.slice(2)], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    child.on("exit", (code, signal) => {
      if (signal) { process.kill(process.pid, signal); return; }
      process.exit(code ?? 1);
    });
  } catch {
    // No bun — use node+tsx
    const tsxPath = join(packageRoot, "node_modules", "tsx", "dist", "loader.mjs");
    const child = spawn(process.execPath, ["--import", tsxPath, entry, ...process.argv.slice(2)], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: { ...process.env, UNBROWSE_PACKAGE_ROOT: packageRoot },
    });
    child.on("exit", (code, signal) => {
      if (signal) { process.kill(process.pid, signal); return; }
      process.exit(code ?? 1);
    });
  }
}
