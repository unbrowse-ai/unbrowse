#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectBrokenMonorepoKuri,
  hashFile,
  hasVendoredBinaries,
  readSourceSha,
  resolveSourceDir,
  shouldRebuildVendoredKuri,
  supportedTargets,
  upstreamBranch,
  upstreamRepoUrl,
} from "./lib/kuri-vendor.mjs";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(packageRoot, "../..");
const vendorRoot = path.join(packageRoot, "vendor", "kuri");

function hasBinary(name) {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checker, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/// Write a small executable stub that prints an error and exits non-zero.
/// Used when cross-compile to a target fails — keeps src/single-binary.ts's
/// import-as-file resolving so Bun can bundle on this host. Real binaries
/// for these targets must be produced by CI on the matching native platform.
function writePlaceholderStub(outFile, targetId) {
  const stub = `#!/bin/sh
# Placeholder kuri binary for ${targetId} — cross-compile from this host
# failed (target system libs needed a sysroot Zig doesn't ship). The real
# binary is built by CI on a native ${targetId} runner.
echo "[unbrowse] kuri binary for ${targetId} not available in this build" >&2
echo "[unbrowse] this happens when the npm package was published from a host" >&2
echo "[unbrowse] that couldn't cross-compile to your platform. File a bug." >&2
exit 1
`;
  writeFileSync(outFile, stub);
  chmodSync(outFile, 0o755);
}

/// Best-effort install of build deps needed for the native kuri build on
/// this host. Linux: zlib + idn2 dev headers (curl-impersonate links them
/// dynamically; Zig errors at link time if absent). Idempotent — apt-get
/// install already-installed packages is a fast no-op.
/// Skipped if not Linux, not in CI (UNBROWSE_AUTO_APT=1 or CI=true), or
/// if apt-get is unavailable.
function ensureNativeBuildDeps() {
  if (process.platform !== "linux") return;
  const inCi = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true" || process.env.UNBROWSE_AUTO_APT === "1";
  if (!inCi) return;
  if (!hasBinary("apt-get")) return;
  try {
    execFileSync("sudo", ["-n", "apt-get", "update", "-qq"], { stdio: "inherit" });
    execFileSync("sudo", ["-n", "apt-get", "install", "-y", "--no-install-recommends",
      "libz-dev", "zlib1g-dev", "libidn2-dev", "build-essential",
    ], { stdio: "inherit" });
  } catch (e) {
    console.warn(`[build-kuri] apt-get install failed (continuing): ${e.message?.split("\n")[0] ?? "unknown"}`);
  }
}

if (detectBrokenMonorepoKuri(packageRoot, repoRoot)) {
  throw new Error(
    "Broken Kuri source checkout at submodules/kuri. Reinit the submodule or set UNBROWSE_KURI_SOURCE_DIR to a clean justrach/kuri checkout.",
  );
}

const sourceDir = resolveSourceDir(packageRoot, repoRoot);
if (!shouldRebuildVendoredKuri({ vendorRoot, sourceDir })) {
  process.exit(0);
}

if (!sourceDir) {
  if (hasVendoredBinaries(vendorRoot)) process.exit(0);
  throw new Error(
    "Kuri source not found. Expected submodules/kuri in the monorepo or vendor/kuri-src in the standalone skill repo.",
  );
}

if (!hasBinary("zig")) {
  if (hasVendoredBinaries(vendorRoot)) process.exit(0);
  throw new Error(`Zig is required to build bundled Kuri binaries from ${sourceDir}`);
}

rmSync(vendorRoot, { recursive: true, force: true });
mkdirSync(vendorRoot, { recursive: true });
const sourceSha = readSourceSha(sourceDir);
const manifest = {
  repo_url: upstreamRepoUrl,
  branch: upstreamBranch,
  source_sha: sourceSha,
  built_at: new Date().toISOString(),
  binaries: {},
};

// Pre-built binaries hosted on GitHub Releases for targets that can't cross-compile reliably
const prebuiltAssets = {
  "darwin-arm64": `https://github.com/lekt9/kuri/releases/download/v0.1.0-${sourceSha?.substring(0, 7)}/kuri`,
};

ensureNativeBuildDeps();

for (const target of supportedTargets) {
  const outDir = path.join(vendorRoot, target.id);
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, target.bin);

  const prebuiltUrl = prebuiltAssets[target.id];
  if (prebuiltUrl) {
    // Download pre-built binary instead of cross-compiling
    console.log(`Downloading pre-built ${target.id} from ${prebuiltUrl}`);
    try {
      execFileSync("curl", ["-fsSL", "-o", outFile, prebuiltUrl], { stdio: "inherit" });
      chmodSync(outFile, 0o755);
      manifest.binaries[target.id] = {
        zig_target: target.zigTarget,
        sha256: hashFile(outFile),
        source: "prebuilt",
      };
      continue;
    } catch (e) {
      console.warn(`Pre-built download failed for ${target.id}, falling back to cross-compile`);
    }
  }

  // Cross-compile with Zig.
  // Detect native target — when host arch+os matches target, skip -Dtarget so
  // zig uses the native sysroot (otherwise system libs like iconv/icucore on
  // macOS or z/idn2 on linux fail to resolve from a missing target sysroot).
  const prefixDir = path.join(os.tmpdir(), `unbrowse-kuri-${target.id}-${process.pid}-${Date.now()}`);
  rmSync(prefixDir, { recursive: true, force: true });
  mkdirSync(prefixDir, { recursive: true });

  const hostArchKey = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  const hostOsKey = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : process.platform;
  const isNative = target.zigTarget === `${hostArchKey}-${hostOsKey}` || target.zigTarget.startsWith(`${hostArchKey}-${hostOsKey}`);
  const zigArgs = isNative
    ? ["build", "-Doptimize=ReleaseFast", "--prefix", prefixDir]
    : ["build", "-Doptimize=ReleaseFast", `-Dtarget=${target.zigTarget}`, "--prefix", prefixDir];

  try {
    execFileSync("zig", zigArgs, {
      cwd: sourceDir,
      stdio: "inherit",
    });
  } catch (e) {
    console.warn(`Cross-compile failed for ${target.id} — writing placeholder stub (${e.message?.split("\n")[0] ?? "unknown error"})`);
    writePlaceholderStub(outFile, target.id);
    rmSync(prefixDir, { recursive: true, force: true });
    manifest.binaries[target.id] = { zig_target: target.zigTarget, source: "placeholder", sha256: hashFile(outFile) };
    continue;
  }

  const builtBinary = path.join(prefixDir, "bin", target.bin);
  if (!existsSync(builtBinary)) {
    console.warn(`Kuri build for ${target.id} produced no binary — writing placeholder stub`);
    writePlaceholderStub(outFile, target.id);
    rmSync(prefixDir, { recursive: true, force: true });
    manifest.binaries[target.id] = { zig_target: target.zigTarget, source: "placeholder", sha256: hashFile(outFile) };
    continue;
  }

  cpSync(builtBinary, outFile);
  chmodSync(outFile, 0o755);
  manifest.binaries[target.id] = {
    zig_target: target.zigTarget,
    sha256: hashFile(outFile),
  };
  rmSync(prefixDir, { recursive: true, force: true });
}

writeFileSync(path.join(vendorRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
