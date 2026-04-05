import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const binaryName = process.platform === "win32" ? "kuri.exe" : "kuri";
export const upstreamRepoUrl = "https://github.com/justrach/kuri.git";
export const upstreamBranch = "adding-extensions";

export const supportedTargets = [
  { id: "darwin-arm64", zigTarget: "aarch64-macos" },
  { id: "darwin-x64", zigTarget: "x86_64-macos" },
  { id: "linux-arm64", zigTarget: "aarch64-linux" },
  { id: "linux-x64", zigTarget: "x86_64-linux" },
  { id: "win-x64", zigTarget: "x86_64-windows" },
];

export function monorepoKuriDir(repoRoot) {
  return path.join(repoRoot, "submodules", "kuri");
}

export function vendoredKuriSourceDir(packageRoot) {
  return path.join(packageRoot, "vendor", "kuri-src");
}

export function sourceDirCandidates(packageRoot, repoRoot, env = process.env) {
  return [
    env.UNBROWSE_KURI_SOURCE_DIR,
    vendoredKuriSourceDir(packageRoot),
    monorepoKuriDir(repoRoot),
  ].filter(Boolean);
}

export function resolveSourceDir(packageRoot, repoRoot, env = process.env) {
  return sourceDirCandidates(packageRoot, repoRoot, env)
    .find((candidate) => existsSync(path.join(candidate, "build.zig"))) || null;
}

export function detectBrokenMonorepoKuri(packageRoot, repoRoot, env = process.env) {
  if (env.UNBROWSE_KURI_SOURCE_DIR) return false;
  const monorepoDir = monorepoKuriDir(repoRoot);
  const vendoredSourceDir = vendoredKuriSourceDir(packageRoot);
  return existsSync(monorepoDir) && !existsSync(path.join(monorepoDir, "build.zig")) && !existsSync(path.join(vendoredSourceDir, "build.zig"));
}

export function hasVendoredBinaries(vendorRoot) {
  return supportedTargets.every((target) => existsSync(path.join(vendorRoot, target.id, binaryName)));
}

export function readVendorManifest(vendorRoot) {
  const manifestPath = path.join(vendorRoot, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

export function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function readSourceSha(sourceDir) {
  if (!sourceDir) return null;
  try {
    return execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function shouldRebuildVendoredKuri({
  vendorRoot,
  sourceDir,
  env = process.env,
}) {
  if (env.UNBROWSE_REBUILD_KURI === "1") return true;
  if (!hasVendoredBinaries(vendorRoot)) return true;
  if (!sourceDir) return false;

  const sourceSha = readSourceSha(sourceDir);
  if (!sourceSha) return false;

  const manifest = readVendorManifest(vendorRoot);
  return manifest?.source_sha !== sourceSha;
}
