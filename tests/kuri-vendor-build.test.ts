import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  binaryName,
  detectBrokenMonorepoKuri,
  readSourceSha,
  shouldRebuildVendoredKuri,
  supportedTargets,
} from "../packages/skill/scripts/lib/kuri-vendor.mjs";

const ROOT = path.resolve(import.meta.dir, "..");
const BUILD_SCRIPT = path.join(ROOT, "packages", "skill", "scripts", "build-kuri-binaries.mjs");
const ASSERT_SCRIPT = path.join(ROOT, "packages", "skill", "scripts", "assert-kuri-vendor.mjs");
const HELPER_SCRIPT = path.join(ROOT, "packages", "skill", "scripts", "lib", "kuri-vendor.mjs");
const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempRoot(prefix: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function makeSourceRepo(root: string) {
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "build.zig"), 'const std = @import("std");\npub fn build(_: *std.Build) void {}\n');
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "build.zig"], { cwd: root, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Codex", "-c", "user.email=codex@example.com", "commit", "-m", "init"],
    { cwd: root, stdio: "ignore" },
  );
}

function makeVendoredBinaries(vendorRoot: string) {
  for (const target of supportedTargets) {
    const targetDir = path.join(vendorRoot, target.id);
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, binaryName), "fake-kuri");
  }
}

describe("Kuri vendor packaging", () => {
  it("rebuilds vendored binaries when the source sha drifts", () => {
    const fixtureRoot = makeTempRoot("unbrowse-kuri-vendor-");
    const sourceDir = path.join(fixtureRoot, "source");
    const vendorRoot = path.join(fixtureRoot, "vendor", "kuri");

    makeSourceRepo(sourceDir);
    makeVendoredBinaries(vendorRoot);

    writeFileSync(path.join(vendorRoot, "manifest.json"), JSON.stringify({
      source_sha: "deadbeef",
    }));

    expect(shouldRebuildVendoredKuri({ vendorRoot, sourceDir })).toBe(true);

    writeFileSync(path.join(vendorRoot, "manifest.json"), JSON.stringify({
      source_sha: readSourceSha(sourceDir),
    }));

    expect(shouldRebuildVendoredKuri({ vendorRoot, sourceDir })).toBe(false);
  });

  it("detects a broken monorepo Kuri checkout before trusting vendored binaries", () => {
    const fixtureRoot = makeTempRoot("unbrowse-kuri-broken-");
    const packageRoot = path.join(fixtureRoot, "packages", "skill");
    const repoRoot = fixtureRoot;

    mkdirSync(path.join(repoRoot, "submodules", "kuri"), { recursive: true });

    expect(detectBrokenMonorepoKuri(packageRoot, repoRoot)).toBe(true);
  });

  it("fails the build script loudly when submodules/kuri is broken", () => {
    const fixtureRoot = makeTempRoot("unbrowse-kuri-build-");
    const packageRoot = path.join(fixtureRoot, "packages", "skill");
    const scriptDir = path.join(packageRoot, "scripts");
    const libDir = path.join(scriptDir, "lib");
    const vendorRoot = path.join(packageRoot, "vendor", "kuri");
    const brokenSubmoduleDir = path.join(fixtureRoot, "submodules", "kuri");

    mkdirSync(libDir, { recursive: true });
    mkdirSync(brokenSubmoduleDir, { recursive: true });
    copyFileSync(BUILD_SCRIPT, path.join(scriptDir, "build-kuri-binaries.mjs"));
    copyFileSync(HELPER_SCRIPT, path.join(libDir, "kuri-vendor.mjs"));
    makeVendoredBinaries(vendorRoot);

    const result = spawnSync("node", [path.join(scriptDir, "build-kuri-binaries.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("Broken Kuri source checkout");
  });

  it("fails the assert script when the baked manifest drifts from source", () => {
    const fixtureRoot = makeTempRoot("unbrowse-kuri-assert-");
    const packageRoot = path.join(fixtureRoot, "packages", "skill");
    const scriptDir = path.join(packageRoot, "scripts");
    const libDir = path.join(scriptDir, "lib");
    const vendorRoot = path.join(packageRoot, "vendor", "kuri");
    const sourceDir = path.join(fixtureRoot, "submodules", "kuri");

    mkdirSync(libDir, { recursive: true });
    copyFileSync(ASSERT_SCRIPT, path.join(scriptDir, "assert-kuri-vendor.mjs"));
    copyFileSync(HELPER_SCRIPT, path.join(libDir, "kuri-vendor.mjs"));
    makeSourceRepo(sourceDir);
    makeVendoredBinaries(vendorRoot);
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "unbrowse",
      files: ["vendor/kuri"],
    }));
    writeFileSync(path.join(vendorRoot, "manifest.json"), JSON.stringify({
      repo_url: "https://github.com/justrach/kuri.git",
      branch: "adding-extensions",
      source_sha: "deadbeef",
      binaries: Object.fromEntries(
        supportedTargets.map((target) => [target.id, { sha256: "bad-hash" }]),
      ),
    }));

    const result = spawnSync("node", [path.join(scriptDir, "assert-kuri-vendor.mjs")], {
      cwd: packageRoot,
      encoding: "utf8",
      env: process.env,
    });

    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("hash mismatch");
  });
});
