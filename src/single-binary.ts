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
import { kuriBinaryName, kuriVendorCandidatePaths, firstExisting } from "./kuri/resolve-paths.js";


// Embed the platform-appropriate kuri binary at compile time.
// Bun's compiled binaries can read files from the virtual /$bunfs/ filesystem
// when they are imported/required at bundle time.
import kuriDarwinArm64Path from "../packages/skill/vendor/kuri/darwin-arm64/kuri" with { type: "file" };
import kuriDarwinX64Path from "../packages/skill/vendor/kuri/darwin-x64/kuri" with { type: "file" };
import kuriLinuxArm64Path from "../packages/skill/vendor/kuri/linux-arm64/kuri" with { type: "file" };
import kuriLinuxX64Path from "../packages/skill/vendor/kuri/linux-x64/kuri" with { type: "file" };
import kuriWinX64Path from "../packages/skill/vendor/kuri/win-x64/kuri.exe" with { type: "file" };

const UNBROWSE_HOME = join(homedir(), ".unbrowse");
// `kuri` on darwin/linux, `kuri.exe` on Windows — the cached/extracted name
// must carry the .exe suffix on Windows or it cannot be exec'd.
const KURI_CACHE = join(UNBROWSE_HOME, "bin", kuriBinaryName());
const EMBEDDED_KURI_BY_TARGET: Record<string, string> = {
  "darwin-arm64": kuriDarwinArm64Path,
  "darwin-x64": kuriDarwinX64Path,
  "linux-arm64": kuriLinuxArm64Path,
  "linux-x64": kuriLinuxX64Path,
  // os.platform() returns "win32" on Windows, so the key is "win32-x64".
  "win32-x64": kuriWinX64Path,
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

  // 4. Alongside this binary, or vendored next to it (.exe-aware on Windows)
  const moduleDir = (() => {
    try { return dirname(new URL(import.meta.url).pathname); } catch { return undefined; }
  })();
  const alongside = firstExisting(
    kuriVendorCandidatePaths({ execDir: dirname(process.execPath), moduleDir }),
    existsSync,
  );
  if (alongside) return alongside;

  // 5. System PATH (`where` on Windows, `which` elsewhere)
  try {
    const probe = process.platform === "win32" ? "where kuri.exe" : "which kuri 2>/dev/null";
    const found = execSync(probe, { encoding: "utf-8" }).split(/\r?\n/)[0]?.trim();
    if (found && existsSync(found)) return found;
  } catch {}

  return null;
}

/**
 * Best-effort kuri provisioning. Returns the resolved binary path, or null when
 * kuri is unavailable on this platform (e.g. no native kuri.exe yet on Windows).
 *
 * This is intentionally NON-FATAL: only the browse/capture paths (go, snap,
 * fetch) actually need kuri, and those resolve + fail honestly on their own when
 * it is missing. The HTTP-only surface — setup, serve, health, resolve, execute
 * — must keep working without a browser, so a missing kuri here must not abort
 * the process. (Previously this hard-exited, which killed every command on
 * platforms without a vendored kuri.)
 */
function ensureKuri(): string | null {
  const kuri = findKuriBinary();
  if (!kuri) {
    if (process.env.UNBROWSE_KURI_TRACE) {
      console.warn("[unbrowse] kuri binary not found — browser capture (go/snap/fetch) will be unavailable.");
      console.warn("[unbrowse] Set KURI_BIN to a kuri binary to enable browsing on this platform.");
    }
    return null;
  }
  process.env.KURI_BIN = kuri;
  return kuri;
}

async function main() {
  const args = process.argv.slice(2);

  // Provision kuri best-effort. Missing kuri only disables the browse paths;
  // HTTP-only commands (setup/serve/health/resolve/execute) still run.
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
  } else if (args[0] === "mcp-serve") {
    await import("./mcp.js");
  } else if (args[0] === "contract-bridge-serve") {
    await import("./contract-bridge.js");
  } else {
    // CLI mode
    await import("./cli.js");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
