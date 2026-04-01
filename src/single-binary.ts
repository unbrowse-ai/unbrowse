#!/usr/bin/env bun
/**
 * Unbrowse single-binary entrypoint.
 *
 * Modes:
 *   unbrowse serve        → start the API server inline
 *   unbrowse [command]    → CLI mode, auto-starts server if not running
 *
 * Kuri discovery (in order):
 *   1. KURI_BIN env var
 *   2. ~/.unbrowse/bin/kuri (pre-installed)
 *   3. Vendored in packages/skill/vendor/kuri/{target}/
 *   4. System PATH
 */

import { existsSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform, arch } from "node:os";
import { execSync } from "node:child_process";

const UNBROWSE_HOME = join(homedir(), ".unbrowse");
const KURI_CACHE = join(UNBROWSE_HOME, "bin", "kuri");

function findKuriBinary(): string | null {
  // 1. Explicit env var
  if (process.env.KURI_BIN && existsSync(process.env.KURI_BIN)) {
    return process.env.KURI_BIN;
  }

  // 2. Alongside this binary (build.sh places kuri here)
  const alongside = join(dirname(process.execPath), "kuri");
  if (existsSync(alongside)) {
    return alongside;
  }

  // 3. Cached in ~/.unbrowse/bin/
  if (existsSync(KURI_CACHE)) {
    return KURI_CACHE;
  }

  const target = `${platform()}-${arch() === "arm64" ? "arm64" : "x64"}`;

  // 4. Vendored paths (npm install, monorepo)
  const candidates = [
    join(dirname(process.execPath), "vendor", "kuri", target, "kuri"),
    join(dirname(process.execPath), "..", "packages", "skill", "vendor", "kuri", target, "kuri"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "unbrowse", "vendor", "kuri", target, "kuri"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      // Cache it for faster future lookups
      mkdirSync(dirname(KURI_CACHE), { recursive: true });
      copyFileSync(candidate, KURI_CACHE);
      chmodSync(KURI_CACHE, 0o755);
      return KURI_CACHE;
    }
  }

  // 5. System PATH
  try {
    const which = execSync("which kuri 2>/dev/null", { encoding: "utf-8" }).trim();
    if (which && existsSync(which)) return which;
  } catch {}

  return null;
}

function ensureKuri(): string {
  const kuri = findKuriBinary();
  if (!kuri) {
    console.error("[unbrowse] kuri binary not found.");
    console.error("[unbrowse] Place kuri next to the unbrowse binary, or set KURI_BIN env var.");
    console.error("[unbrowse] Or run: unbrowse setup");
    process.exit(1);
  }
  process.env.KURI_BIN = kuri;
  return kuri;
}

async function main() {
  const args = process.argv.slice(2);

  // Ensure kuri is available
  ensureKuri();

  if (args[0] === "serve") {
    // Server mode — run inline
    const { startUnbrowseServer, installServerExitCleanup } = await import("./server.js");
    const { config: loadEnv } = await import("dotenv");

    loadEnv({ quiet: true });
    loadEnv({ path: ".env.runtime", quiet: true });

    const pidFile = process.env.UNBROWSE_PID_FILE;
    installServerExitCleanup(pidFile);

    const server = await startUnbrowseServer({
      pidFile,
      scheduleVerification: true,
    });

    const shutdown = async (signal: string) => {
      console.log(`[shutdown] ${signal}`);
      await server.close();
      process.exit(0);
    };

    process.on("SIGTERM", () => shutdown("SIGTERM").catch(() => process.exit(1)));
    process.on("SIGINT", () => shutdown("SIGINT").catch(() => process.exit(1)));

    console.log(`unbrowse running on http://${server.host}:${server.port}`);
  } else {
    // CLI mode
    await import("./cli.js");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
