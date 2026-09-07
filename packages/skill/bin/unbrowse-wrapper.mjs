#!/usr/bin/env node

/**
 * Thin wrapper — runs an explicitly-provided compiled binary if present (the
 * UNBROWSE_INSTALL_BINARY_PATH opt-in, used by CI smoke tests), else the package's
 * readable, unsigned runtime via the launcher. There is NO auto-download fallback —
 * the readable runtime is the default; the runtime IS the client.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// Signals a supervising client (an MCP host, a shell, a test harness) sends to
// end us. Node's DEFAULT action for these terminates this process WITHOUT
// touching the child, which is how a spawned tree orphans: the client kills the
// process it knows about (us) and every descendant survives, holding its RSS
// forever. Any surviving spawn hop must therefore forward explicitly.
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

function spawnEntrypoint(command, args) {
  const child = spawn(command, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });

  // Forward, don't die alone. Registering a handler also SUPPRESSES the default
  // terminate action, so we stay alive to reap the child and mirror its exit
  // status — the child's own exit handler below is what finally ends us.
  const forward = (signal) => {
    try { if (child.exitCode === null && child.signalCode === null) child.kill(signal); } catch { /* already gone */ }
  };
  const handlers = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => forward(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  // Last-resort backstop: if we exit for any reason the child did not cause
  // (an uncaught throw, an explicit process.exit elsewhere), do not leave it
  // orphaned. Only `exit` is synchronous-safe here, so SIGKILL it directly.
  const onExit = () => {
    try { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } catch { /* already gone */ }
  };
  process.on("exit", onExit);

  child.on("error", (error) => {
    const details = error instanceof Error ? error.message : String(error);
    if (error && typeof error === "object" && "code" in error && error.code === "EACCES") {
      failInstall(`Launch target is not executable (${command}). Global install permissions are corrupted.`);
    }
    failInstall(`Failed to launch ${command}: ${details}`);
  });
  child.on("exit", (code, signal) => {
    // Drop our handlers so re-raising below hits Node's DEFAULT action and this
    // process actually dies with the right status instead of catching itself.
    for (const [name, handler] of handlers) process.off(name, handler);
    process.off("exit", onExit);
    if (signal) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 1);
  });
}

/**
 * Default path: run the launcher IN THIS PROCESS.
 *
 * The launcher is plain ESM run by the same Node that is already executing this
 * file, so spawning a second interpreter to run it bought nothing but a process
 * that had to be signalled, waited on, and reaped — and, when that forwarding was
 * missing, an orphan. Importing it collapses the hop entirely: there is no child
 * to lose, and a SIGTERM from the client lands directly on the code doing the work.
 *
 * `process.argv` is rewritten to exactly the shape the spawn produced
 * (`[execPath, launcherPath, ...userArgs]`) because the runtime identifies its
 * entrypoint by comparing `process.argv[1]` against its own module path
 * (`isMainModule` in src/runtime/paths.ts). Leave argv[1] pointing at this
 * wrapper and that comparison fails, auto-main never fires, and the CLI exits
 * silently having done nothing.
 */
async function runLauncherInProcess() {
  process.argv = [process.execPath, launcherPath, ...process.argv.slice(2)];
  await import(pathToFileURL(launcherPath).href);
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  const v = readInstalledVersion();
  if (process.env.UNBROWSE_BEE_MODE === "1") {
    const alias = process.env.UNBROWSE_BEE_ALIAS || "pollen";
    process.stdout.write(`${v} 🐝 ${alias} → unbrowse\n`);
  } else {
    process.stdout.write(`${v}\n`);
  }
  process.exit(0);
}

if (existsSync(binaryPath)) {
  // an explicitly-injected binary (UNBROWSE_INSTALL_BINARY_PATH) — not a fallback.
  // A foreign executable genuinely cannot be imported, so this hop stays a real
  // spawn; it is signal-transparent via spawnEntrypoint's forwarding.
  spawnEntrypoint(binaryPath, process.argv.slice(2));
} else {
  // the default: the readable, unsigned runtime via the launcher. The source IS the
  // runtime, so the client is auditable on disk — security lives in the wallet-sealed
  // crypto, not in hiding the client. The hole fills any internet gap.
  await runLauncherInProcess();
}
