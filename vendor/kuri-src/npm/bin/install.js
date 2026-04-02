#!/usr/bin/env node
// Downloads the correct kuri-agent binary for the current platform at install time.
// Inspired by the pattern used by esbuild, agent-browser, etc.
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");
const zlib = require("zlib");

const REPO = "justrach/kuri";
const VERSION = require("../package.json").version;
const BIN_DIR = path.join(__dirname);
const BIN_PATH = path.join(BIN_DIR, "kuri-agent-bin");

function platform() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const opsys = process.platform === "darwin" ? "macos" : "linux";
  return `${arch}-${opsys}`;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on("finish", resolve);
        out.on("error", reject);
      }).on("error", reject);
    };
    follow(url);
  });
}

async function main() {
  const target = platform();
  const url = `https://github.com/${REPO}/releases/download/v${VERSION}/kuri-v${VERSION}-${target}.tar.gz`;
  const tmp = path.join(os.tmpdir(), `kuri-${Date.now()}.tar.gz`);

  console.log(`kuri-agent: downloading ${target} binary...`);
  await downloadFile(url, tmp);

  // Extract kuri-agent from tarball using tar
  fs.mkdirSync(BIN_DIR, { recursive: true });
  execFileSync("tar", ["-xzf", tmp, "-C", BIN_DIR, "kuri-agent"]);
  fs.renameSync(path.join(BIN_DIR, "kuri-agent"), BIN_PATH);
  fs.chmodSync(BIN_PATH, 0o755);
  fs.unlinkSync(tmp);

  // Remove macOS quarantine
  if (process.platform === "darwin") {
    try { execFileSync("xattr", ["-d", "com.apple.quarantine", BIN_PATH]); } catch {}
  }
  console.log(`kuri-agent: installed to ${BIN_PATH}`);
}

main().catch((e) => { console.error("kuri-agent install failed:", e.message); process.exit(1); });
