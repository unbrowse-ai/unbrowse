#!/usr/bin/env node

/**
 * postinstall — download the platform-specific compiled binary.
 *
 * The npm package is a thin wrapper. The real binary is a bun-compiled
 * single binary with kuri embedded. This script downloads it from
 * GitHub releases on `npm install`.
 */

import { existsSync, mkdirSync, chmodSync, createWriteStream, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const binDir = join(packageRoot, "bin");
const binaryPath = join(binDir, "unbrowse");

// Skip if binary already exists (re-install)
if (existsSync(binaryPath)) {
  process.exit(0);
}

const platform = process.platform; // darwin, linux
const arch = process.arch; // arm64, x64
const target = `${platform}-${arch}`;

const SUPPORTED = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
if (!SUPPORTED.includes(target)) {
  console.warn(`[unbrowse] No prebuilt binary for ${target}. Falling back to source mode.`);
  process.exit(0);
}

// Read version from package.json
const pkg = JSON.parse(
  (await import("node:fs")).readFileSync(join(packageRoot, "package.json"), "utf-8")
);
const version = pkg.version;
const repo = "unbrowse-ai/unbrowse";
const assetName = `unbrowse-${target}`;
const url = `https://github.com/${repo}/releases/download/v${version}/${assetName}`;

console.log(`[unbrowse] Downloading binary for ${target} (v${version})...`);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url, redirects = 0) => {
      if (redirects > 5) return reject(new Error("Too many redirects"));
      https.get(url, { headers: { "User-Agent": "unbrowse-postinstall" } }, (res) => {
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
  console.warn(`[unbrowse] Falling back to source mode (requires bun or node+tsx).`);
  // Clean up partial download
  try { unlinkSync(binaryPath); } catch {}
}
