#!/usr/bin/env node

/**
 * postinstall — persist install attribution + wire up the runtime.
 *
 * The npm package ships a readable, unsigned Bun runtime (runtime/cli.js) that the
 * launcher runs. There is NO binary download and no auto-download fallback — the
 * runtime IS the client, and the hole fills any internet gap. A prebuilt binary can
 * still be injected explicitly via UNBROWSE_INSTALL_BINARY_PATH (used by CI smoke
 * tests); the wrapper runs that when present, else the readable runtime.
 */
import { existsSync, mkdirSync, chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { unbrowseBinaryName } from "./release-assets.mjs";

// --- Persist landing attribution from env to disk ---
// UNBROWSE_LANDING_TOKEN / UNBROWSE_ATTRIBUTION_B64 are set when the user copies the
// install command from the landing page; they only live during this npm install, so
// persist them for the CLI to read on first `unbrowse setup`.
try {
  const landingToken = process.env.UNBROWSE_LANDING_TOKEN?.trim();
  const attributionB64 = process.env.UNBROWSE_ATTRIBUTION_B64?.trim();
  if (landingToken || attributionB64) {
    const attrDir = join(homedir(), ".unbrowse");
    mkdirSync(attrDir, { recursive: true });
    writeFileSync(
      join(attrDir, "landing-attribution.json"),
      JSON.stringify(
        {
          persisted_at: new Date().toISOString(),
          ...(landingToken ? { landing_token: landingToken } : {}),
          ...(attributionB64 ? { attribution_b64: attributionB64 } : {}),
        },
        null,
        2,
      ),
      "utf8",
    );
  }
} catch {
  /* Attribution is best-effort — never block install */
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const binDir = join(packageRoot, "bin");
const binaryPath = join(binDir, unbrowseBinaryName(process.platform));

function ensureExecutable(filePath) {
  if (!existsSync(filePath)) return;
  try {
    chmodSync(filePath, 0o755);
  } catch {
    /* Leave best-effort permission repair to the wrapper diagnostics. */
  }
}

ensureExecutable(join(binDir, "unbrowse-wrapper.mjs"));
ensureExecutable(join(binDir, "unbrowse.js"));

// Explicit prebuilt-binary opt-in (CI smoke tests). Not a fallback — only honored
// when a path is given; the wrapper runs it when present, else the readable runtime.
const localBinaryPath = process.env.UNBROWSE_INSTALL_BINARY_PATH;
if (localBinaryPath) {
  if (!existsSync(localBinaryPath)) {
    console.warn(`[unbrowse] Local binary override not found: ${localBinaryPath}`);
    process.exit(1);
  }
  mkdirSync(binDir, { recursive: true });
  copyFileSync(localBinaryPath, binaryPath);
  chmodSync(binaryPath, 0o755);
  console.log(`[unbrowse] Installed local binary override: ${binaryPath}`);
  process.exit(0);
}

// Default: confirm the readable runtime shipped; the launcher runs it via Bun.
if (!existsSync(join(packageRoot, "runtime", "cli.js"))) {
  console.warn("[unbrowse] readable runtime missing (runtime/cli.js); reinstall: npm install -g unbrowse@latest");
}

// Opt-in install telemetry ping (default OFF; UNBROWSE_TELEMETRY=1 to enable).
// Spawned detached + unref'd so it can never block the install.
try {
  if (process.env.UNBROWSE_TELEMETRY === "1") {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [join(__dirname, "postinstall-ping.mjs")], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
  }
} catch {
  /* Telemetry must never break install. */
}

// konmari: keep only THIS host's vendored native binaries — deletes the other platforms'
// (~40 MB lighter per install). Fail-safe + idempotent in the script; never blocks/breaks
// install. Opt out with UNBROWSE_NO_PRUNE=1.
try {
  const { spawnSync } = await import("node:child_process");
  spawnSync(process.execPath, [join(__dirname, "prune-foreign-binaries.mjs")], {
    stdio: "inherit",
    env: process.env,
  });
} catch {
  /* The prune is best-effort; install must never break on it. */
}
