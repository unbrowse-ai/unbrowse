#!/usr/bin/env node

/**
 * postinstall — download the platform-specific compiled binary.
 *
 * The npm package is a thin wrapper. The real binary is a bun-compiled
 * single binary with kuri embedded. This mirrors Kuri's npm install flow:
 * fetch the matching GitHub release asset, wire it into `bin/`, and fall
 * back to the packaged runtime if the release asset is missing.
 */
import { existsSync, mkdirSync, chmodSync, copyFileSync, createWriteStream, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import http from "node:http";
import https from "node:https";
import { SUPPORTED_TARGETS, buildBinaryArchiveName, buildReleaseAssetUrl, getReleaseAssetConfig } from "./release-assets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const binDir = join(packageRoot, "bin");
const binaryPath = join(binDir, "unbrowse");
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
  process.exit(0);
}

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

const platform = process.platform; // darwin, linux
const arch = process.arch; // arm64, x64
const target = `${platform}-${arch}`;

if (!SUPPORTED_TARGETS.includes(target)) {
  console.warn(`[unbrowse] No prebuilt binary for ${target}.`);
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

try {
  const archivePath = join(tmpdir(), assetName);
  const extractDir = join(tmpdir(), `unbrowse-install-${process.pid}`);
  await download(url, archivePath);
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", extractDir]);
  const extractedBinary = join(extractDir, "unbrowse");
  if (!existsSync(extractedBinary)) {
    throw new Error(`Archive ${assetName} did not contain ./unbrowse`);
  }
  mkdirSync(binDir, { recursive: true });
  copyFileSync(extractedBinary, binaryPath);
  chmodSync(binaryPath, 0o755);
  try { unlinkSync(archivePath); } catch {}
  try { unlinkSync(extractedBinary); } catch {}
  console.log(`[unbrowse] Binary installed: ${binaryPath}`);
} catch (err) {
  console.warn(`[unbrowse] Binary download failed: ${err.message}`);
  console.warn(`[unbrowse] Falling back to source mode for ${repo} ${tag} (${target}).`);
  try { unlinkSync(binaryPath); } catch {}
}
