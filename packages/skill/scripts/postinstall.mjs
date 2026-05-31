#!/usr/bin/env node

/**
 * postinstall — download the platform-specific compiled binary.
 *
 * The npm package is a thin wrapper. The real binary is a bun-compiled
 * single binary with kuri embedded. This mirrors Kuri's npm install flow:
 * fetch the matching GitHub release asset, wire it into `bin/`, and fall
 * back to the packaged runtime if the release asset is missing.
 */
import { existsSync, mkdirSync, chmodSync, copyFileSync, createWriteStream, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import http from "node:http";
import https from "node:https";
import { SUPPORTED_TARGETS, buildBinaryArchiveName, buildReleaseAssetUrl, getReleaseAssetConfig, unbrowseBinaryName } from "./release-assets.mjs";

// --- Persist landing attribution from env to disk ---
// The UNBROWSE_LANDING_TOKEN env var is set when the user copies the install
// command from the landing page. It only lives during this npm install process.
// Persist it to disk so the CLI can read it back on first `unbrowse setup`.
try {
  const landingToken = process.env.UNBROWSE_LANDING_TOKEN?.trim();
  const attributionB64 = process.env.UNBROWSE_ATTRIBUTION_B64?.trim();
  if (landingToken || attributionB64) {
    const attrDir = join(homedir(), ".unbrowse");
    mkdirSync(attrDir, { recursive: true });
    writeFileSync(
      join(attrDir, "landing-attribution.json"),
      JSON.stringify({
        persisted_at: new Date().toISOString(),
        ...(landingToken ? { landing_token: landingToken } : {}),
        ...(attributionB64 ? { attribution_b64: attributionB64 } : {}),
      }, null, 2),
      "utf8",
    );
  }
} catch { /* Attribution is best-effort — never block install */ }

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const binDir = join(packageRoot, "bin");
// On Windows the compiled binary is `unbrowse.exe`; everywhere else it's
// `unbrowse`. The wrapper (bin/unbrowse-wrapper.mjs) resolves the same name,
// so both sides must agree — the decision lives in release-assets.mjs.
const installedBinaryName = unbrowseBinaryName(process.platform);
const binaryPath = join(binDir, installedBinaryName);
const localBinaryPath = process.env.UNBROWSE_INSTALL_BINARY_PATH;
const wrapperPath = join(binDir, "unbrowse-wrapper.mjs");
const launcherPath = join(binDir, "unbrowse.js");

function ensureExecutable(filePath) {
  if (!existsSync(filePath)) return;
  try {
    chmodSync(filePath, 0o755);
  } catch {
    // Leave best-effort permission repair to the wrapper diagnostics.
  }
}

ensureExecutable(wrapperPath);
ensureExecutable(launcherPath);

// Skip if binary already exists (re-install)
if (existsSync(binaryPath)) {
  ensureExecutable(binaryPath);
  console.log(`[unbrowse] Binary already exists, skipping.`);
  process.exit(0);
}

// Local binary override — used by smoke tests to inject a pre-built binary.
// Must run BEFORE the CI skip so packaged smoke tests work in GitHub Actions.
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

// Skip binary download in CI build environments — the release pipeline builds
// binaries AFTER install, so the download would always 404 and fail.
// Placed after the local binary override so smoke tests still work.
if (process.env.CI && (process.env.GITHUB_ACTIONS || process.env.UNBROWSE_SKIP_BINARY_DOWNLOAD)) {
  process.exit(0);
}

// `process.platform` returns 'win32' on Windows but our SUPPORTED_TARGETS
// names use 'win' (e.g. 'win-x64'). Normalize before composing the target
// key. 'darwin' and 'linux' pass through unchanged.
const platformRaw = process.platform; // darwin | linux | win32 | ...
const platform = platformRaw === "win32" ? "win" : platformRaw;
const arch = process.arch; // arm64, x64
const target = `${platform}-${arch}`;

if (!SUPPORTED_TARGETS.includes(target)) {
  console.warn(`[unbrowse] No prebuilt binary for ${target} (platform=${platformRaw}, arch=${arch}).`);
  console.warn("[unbrowse] Falling back to source mode.");
  process.exit(0);
}

const { repo, tag, baseUrl, version } = getReleaseAssetConfig(packageRoot);
const assetName = buildBinaryArchiveName(version, target);
const url = buildReleaseAssetUrl(baseUrl, tag, assetName);

console.log(`[unbrowse] Downloading binary for ${target} (${tag})...`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      const client = url.startsWith("http://") ? http : https;
      client.get(url, { headers: { "User-Agent": "unbrowse-postinstall" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
        mkdirSync(dirname(dest), { recursive: true });
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          chmodSync(dest, 0o755);
          resolve();
        });
      }).on("error", reject);
    };
    follow(url);
  });
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [2000, 5000, 10000];
let lastError;

for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
  try {
    if (attempt > 0) {
      console.log(`[unbrowse] Retry ${attempt}/${MAX_RETRIES - 1}...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt - 1] || 5000));
    }
    const archivePath = join(tmpdir(), assetName);
    const extractDir = join(tmpdir(), `unbrowse-install-${process.pid}`);
    await download(url, archivePath);
    mkdirSync(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir]);
    // The win-x64 tarball packs `unbrowse.exe` at the archive root; darwin/linux
    // pack `unbrowse`. Prefer the target-appropriate member, but accept either
    // layout so an unexpectedly-named asset still installs.
    const memberName = unbrowseBinaryName(target);
    const memberCandidates = [join(extractDir, memberName), join(extractDir, "unbrowse"), join(extractDir, "unbrowse.exe")];
    const extractedBinary = memberCandidates.find((p) => existsSync(p));
    if (!extractedBinary) {
      throw new Error(`Archive ${assetName} did not contain ${memberName}`);
    }
    mkdirSync(binDir, { recursive: true });
    copyFileSync(extractedBinary, binaryPath);
    chmodSync(binaryPath, 0o755);
    try { unlinkSync(archivePath); } catch {}
    try { unlinkSync(extractedBinary); } catch {}
    console.log(`[unbrowse] Binary installed: ${binaryPath}`);
    lastError = null;
    break;
  } catch (err) {
    lastError = err;
    try { unlinkSync(binaryPath); } catch {}
  }
}

if (lastError) {
  console.error(`[unbrowse] Binary download failed after ${MAX_RETRIES} attempts: ${lastError.message}`);
  console.error(`[unbrowse] Run "node ${join(packageRoot, "scripts", "postinstall.mjs")}" to retry.`);
  console.error(`[unbrowse] The CLI will fall back to source mode but may be slower.`);
  process.exitCode = 1;
}

// Opt-in install telemetry ping. Default OFF: only fires when the user
// (or distro) sets UNBROWSE_TELEMETRY=1. Spawned detached + unref'd so
// it can never block the install, even if the network hangs.
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
  // Telemetry must never break install.
}
