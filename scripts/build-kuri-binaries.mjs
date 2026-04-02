#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(packageRoot, "../..");
const vendorRoot = path.join(packageRoot, "vendor", "kuri");
const binaryName = process.platform === "win32" ? "kuri.exe" : "kuri";

const supportedTargets = [
  { id: "darwin-arm64", zigTarget: "aarch64-macos" },
  { id: "darwin-x64", zigTarget: "x86_64-macos" },
  { id: "linux-arm64", zigTarget: "aarch64-linux" },
  { id: "linux-x64", zigTarget: "x86_64-linux" },
];

function hasBinary(name) {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checker, [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function resolveSourceDir() {
  const candidates = [
    process.env.UNBROWSE_KURI_SOURCE_DIR,
    path.join(packageRoot, "vendor", "kuri-src"),
    path.join(repoRoot, "submodules", "kuri"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(path.join(candidate, "build.zig"))) || null;
}

function hasVendoredBinaries() {
  return supportedTargets.every((target) => existsSync(path.join(vendorRoot, target.id, binaryName)));
}

if (hasVendoredBinaries() && process.env.UNBROWSE_REBUILD_KURI !== "1") {
  process.exit(0);
}

const sourceDir = resolveSourceDir();
if (!sourceDir) {
  if (hasVendoredBinaries()) process.exit(0);
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
  rmSync(prefixDir, { recursive: true, force: true });
}
