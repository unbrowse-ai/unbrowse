#!/usr/bin/env bun
/**
 * Unbrowse single-binary entrypoint.
 *
 * Modes:
 *   unbrowse serve        → start the API server inline
 *   unbrowse [command]    → CLI mode, auto-starts server if not running
 *
 * Kuri is embedded as a file asset. On first run it's extracted to
 * ~/.unbrowse/bin/kuri and reused from there.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform, arch } from "node:os";
import { execSync } from "node:child_process";


// Embed the platform-appropriate kuri binary at compile time.
// Bun's compiled binaries can read files from the virtual /$bunfs/ filesystem
// when they are imported/required at bundle time.
import kuriDarwinArm64Path from "../packages/skill/vendor/kuri/darwin-arm64/kuri" with { type: "file" };
import kuriDarwinX64Path from "../packages/skill/vendor/kuri/darwin-x64/kuri" with { type: "file" };
import kuriLinuxArm64Path from "../packages/skill/vendor/kuri/linux-arm64/kuri" with { type: "file" };
import kuriLinuxX64Path from "../packages/skill/vendor/kuri/linux-x64/kuri" with { type: "file" };

const UNBROWSE_HOME = join(homedir(), ".unbrowse");
const KURI_CACHE = join(UNBROWSE_HOME, "bin", "kuri");
const EMBEDDED_KURI_BY_TARGET: Record<string, string> = {
  "darwin-arm64": kuriDarwinArm64Path,
  "darwin-x64": kuriDarwinX64Path,
  "linux-arm64": kuriLinuxArm64Path,
  "linux-x64": kuriLinuxX64Path,
};

function currentKuriTarget(): string {
  return `${platform()}-${arch()}`;
}

function extractEmbeddedKuri(): string | null {
  const kuriBinaryPath = EMBEDDED_KURI_BY_TARGET[currentKuriTarget()];
  if (!kuriBinaryPath) {
    console.warn(`[unbrowse] no embedded kuri available for ${currentKuriTarget()}`);
    return null;
  }
  try {
    const data = readFileSync(kuriBinaryPath);
    mkdirSync(dirname(KURI_CACHE), { recursive: true });
    writeFileSync(KURI_CACHE, data);
    chmodSync(KURI_CACHE, 0o755);
    console.log(`[unbrowse] extracted kuri to ${KURI_CACHE}`);
    return KURI_CACHE;
  } catch (err) {
    console.warn(`[unbrowse] kuri extraction failed: ${(err as Error).message}`);
    return null;
  }
}
function findKuriBinary(): string | null {
  // 1. Explicit env var
  if (process.env.KURI_BIN && existsSync(process.env.KURI_BIN)) {
    return process.env.KURI_BIN;
  }

  // 2. Cached in ~/.unbrowse/bin/ (previously extracted)
  if (existsSync(KURI_CACHE)) {
    return KURI_CACHE;
  }

  // 3. Extract from embedded asset
  const extracted = extractEmbeddedKuri();
  if (extracted) return extracted;

  // 4. Alongside this binary
  const alongside = join(dirname(process.execPath), "kuri");
  if (existsSync(alongside)) {
    return alongside;
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
