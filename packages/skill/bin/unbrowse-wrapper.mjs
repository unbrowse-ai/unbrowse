#!/usr/bin/env node

/**
 * Thin wrapper — runs an explicitly-provided compiled binary if present (the
 * UNBROWSE_INSTALL_BINARY_PATH opt-in, used by CI smoke tests), else the package's
 * readable, unsigned runtime via the launcher. There is NO auto-download fallback —
 * the readable runtime is the default; the runtime IS the client.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { unbrowseBinaryName } from "../scripts/release-assets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const binaryPath = join(__dirname, unbrowseBinaryName(process.platform));
const launcherPath = join(__dirname, "unbrowse.js");

function readInstalledVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function printRepairHelp(reason) {
  const installedVersion = readInstalledVersion();
  const lines = [
    `[unbrowse] ${reason}`,
    `[unbrowse] Installed package version: ${installedVersion}`,
    "[unbrowse] Repair: npm uninstall -g unbrowse && npm install -g unbrowse@latest",
  ];
  process.stderr.write(lines.join("\n") + "\n");
}

function failInstall(reason, exitCode = 1) {
  printRepairHelp(reason);
  process.exit(exitCode);
}

function spawnEntrypoint(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
  child.on("error", (error) => {
    const details = error instanceof Error ? error.message : String(error);
    if (error && typeof error === "object" && "code" in error && error.code === "EACCES") {
      failInstall(`Launch target is not executable (${command}). Global install permissions are corrupted.`);
    }
    failInstall(`Failed to launch ${command}: ${details}`);
  });
  child.on("exit", (code, signal) => {
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  });
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`${readInstalledVersion()}\n`);
  process.exit(0);
}

if (existsSync(binaryPath)) {
  // an explicitly-injected binary (UNBROWSE_INSTALL_BINARY_PATH) — not a fallback
  spawnEntrypoint(binaryPath, process.argv.slice(2));
} else {
  // the default: the readable, unsigned runtime via the launcher. The source IS the
  // runtime, so the client is auditable on disk — security lives in the wallet-sealed
  // crypto, not in hiding the client. The hole fills any internet gap.
  spawnEntrypoint(process.execPath, [launcherPath, ...process.argv.slice(2)]);
}
