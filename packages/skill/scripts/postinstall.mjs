#!/usr/bin/env node

/**
 * postinstall — download the platform-specific compiled binary.
 *
 * The npm package is a thin wrapper. The real binary is a bun-compiled
 * single binary with kuri embedded. This mirrors Kuri's npm install flow:
 * fetch the matching GitHub release tarball, extract `unbrowse`, wire it
 * into `bin/`, and fall back to source mode if the release asset is missing.
 */
import { existsSync, mkdirSync, chmodSync, createWriteStream, unlinkSync, readFileSync } from "node:fs";
import { existsSync, mkdirSync, chmodSync, copyFileSync, createWriteStream, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { SUPPORTED_TARGETS, buildReleaseAssetUrl, getReleaseAssetConfig } from "./release-assets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const binDir = join(packageRoot, "bin");
const binaryPath = join(binDir, "unbrowse");
const localBinaryPath = process.env.UNBROWSE_INSTALL_BINARY_PATH;

// Skip if binary already exists (re-install)
if (existsSync(binaryPath)) process.exit(0);

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
  console.warn("[unbrowse] This package ships only the native binary wrapper.");
  process.exit(0);
}

const { version, repo, tag, baseUrl } = getReleaseAssetConfig(packageRoot);
const assetName = `unbrowse-${target}`;
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
  await download(url, binaryPath);
  console.log(`[unbrowse] Binary installed: ${binaryPath}`);
} catch (err) {
  console.warn(`[unbrowse] Binary download failed: ${err.message}`);
  console.warn(`[unbrowse] Install failed: native binary unavailable for ${repo} ${tag} (${target}).`);
  try { unlinkSync(binaryPath); } catch {}
  process.exit(1);
}
