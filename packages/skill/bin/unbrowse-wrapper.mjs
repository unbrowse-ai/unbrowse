#!/usr/bin/env node

/**
 * Thin wrapper — execs the compiled binary if available,
 * falls back to the package-managed Node launcher if not.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const binaryPath = join(__dirname, "unbrowse");
const launcherPath = join(__dirname, "unbrowse.js");
const require = createRequire(import.meta.url);

const REQUIRED_FALLBACK_PACKAGES = [
  "tsx",
  "bs58",
  "@solana/kit",
  "@cascade-fyi/splits-sdk",
];

const KNOWN_BAD_FALLBACK_VERSIONS = new Set([
  "2.10.2",
]);

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

function missingFallbackPackages() {
  const missing = [];
  for (const specifier of REQUIRED_FALLBACK_PACKAGES) {
    try {
      require.resolve(specifier);
    } catch {
      missing.push(specifier);
    }
  }
  return missing;
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
  // Compiled binary — exec directly, replace this process
  spawnEntrypoint(binaryPath, process.argv.slice(2));
} else {
  const installedVersion = readInstalledVersion();
  if (KNOWN_BAD_FALLBACK_VERSIONS.has(installedVersion)) {
    failInstall(
      `Installed package version ${installedVersion} is known-bad in source fallback mode and shipped an incomplete runtime dependency set.`,
    );
  }

  const missing = missingFallbackPackages();
  if (missing.length > 0) {
    failInstall(`Fallback runtime is missing required packages: ${missing.join(", ")}.`);
  }

  // Fallback: delegate to the stable package launcher so
  // npm installs and npx use the same dependency resolution path.
  spawnEntrypoint(process.execPath, [launcherPath, ...process.argv.slice(2)]);
}
