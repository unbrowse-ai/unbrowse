#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  binaryName,
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
  if (hasVendoredBinaries()) process.exit(0);
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

for (const target of supportedTargets) {
  const prefixDir = path.join(os.tmpdir(), `unbrowse-kuri-${target.id}-${process.pid}-${Date.now()}`);
  rmSync(prefixDir, { recursive: true, force: true });
  mkdirSync(prefixDir, { recursive: true });

  execFileSync("zig", ["build", "-Doptimize=ReleaseFast", `-Dtarget=${target.zigTarget}`, "--prefix", prefixDir], {
    cwd: sourceDir,
    stdio: "inherit",
  });

  const builtBinary = path.join(prefixDir, "bin", binaryName);
  if (!existsSync(builtBinary)) {
    throw new Error(`Kuri build succeeded for ${target.id}, but ${builtBinary} is missing`);
  }

  const outDir = path.join(vendorRoot, target.id);
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, binaryName);
  cpSync(builtBinary, outFile);
  chmodSync(outFile, 0o755);
  manifest.binaries[target.id] = {
    zig_target: target.zigTarget,
    sha256: hashFile(outFile),
  };
  rmSync(prefixDir, { recursive: true, force: true });
}

writeFileSync(path.join(vendorRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
