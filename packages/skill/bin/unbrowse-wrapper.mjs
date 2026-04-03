#!/usr/bin/env node

/**
 * Thin wrapper — execs the compiled binary only.
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
  console.error("[unbrowse] Native CLI binary is missing.");
  console.error("[unbrowse] Reinstall the package or verify the release asset exists for this platform.");
  process.exit(1);
}
