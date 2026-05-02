#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_RELEASE_REPO = "unbrowse-ai/unbrowse";
const DEFAULT_DIST_TAG = "preview";

function parseArgs(argv) {
  const args = {
    backendUrl: "",
    version: "",
    distTag: DEFAULT_DIST_TAG,
    releaseRepo: process.env.UNBROWSE_RELEASE_REPO || DEFAULT_RELEASE_REPO,
    keepTemp: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--backend-url") args.backendUrl = argv[++i] || "";
    else if (arg === "--version") args.version = argv[++i] || "";
    else if (arg === "--tag") args.distTag = argv[++i] || DEFAULT_DIST_TAG;
    else if (arg === "--repo") args.releaseRepo = argv[++i] || DEFAULT_RELEASE_REPO;
    else if (arg === "--keep-temp") args.keepTemp = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown arg: ${arg}`);
  }

  return args;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function formatPreviewVersion(baseVersion, stamp = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const utc = [
    stamp.getUTCFullYear(),
    pad(stamp.getUTCMonth() + 1),
    pad(stamp.getUTCDate()),
    pad(stamp.getUTCHours()),
    pad(stamp.getUTCMinutes()),
    pad(stamp.getUTCSeconds()),
  ].join("");
  return `${baseVersion}-preview.${utc}`;
}

export function resolvePreviewBackendUrl(env = process.env, explicit = "") {
  const value = explicit
    || env.UNBROWSE_PREVIEW_BACKEND_URL
    || env.EXPERIMENTS_API_URL
    || env.PREVIEW_API_URL
    || "";
  return value.trim();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    encoding: "utf8",
    stdio: options.stdio || "inherit",
    env: {
      ...process.env,
      ...options.env,
    },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? 1}`);
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireCommand(name, args = ["--version"]) {
  try {
    execFileSync(name, args, { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    throw new Error(`missing required command: ${name}`);
  }
}

function makeTempRepoCopy(root) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "unbrowse-preview-publish-"));
  cpSync(root, tempRoot, {
    recursive: true,
    filter(src) {
      const base = path.basename(src);
      return base !== ".git" && base !== "node_modules" && base !== "dist";
    },
  });
  return tempRoot;
}

function shouldSyncSubmodules(repoRoot) {
  return existsSync(path.join(repoRoot, ".git"));
}

function writePreviewVersions(repoRoot, previewVersion) {
  const rootPkgPath = path.join(repoRoot, "package.json");
  const skillPkgPath = path.join(repoRoot, "packages", "skill", "package.json");
  const versionJsonPath = path.join(repoRoot, "version.json");

  const rootPkg = readJson(rootPkgPath);
  const skillPkg = readJson(skillPkgPath);
  const versionJson = readJson(versionJsonPath);

  rootPkg.version = previewVersion;
  skillPkg.version = previewVersion;
  versionJson.version = previewVersion;

  writeJson(rootPkgPath, rootPkg);
  writeJson(skillPkgPath, skillPkg);
  writeJson(versionJsonPath, versionJson);
}

function releaseAssetArgs(repoRoot) {
  const distDir = path.join(repoRoot, "dist");
  const releaseAssets = readdirSync(distDir)
    .filter((name) => name.endsWith(".tar.gz") || name === "release-manifest.json" || name === "release-manifest.sig")
    .map((name) => path.join("dist", name));
  if (releaseAssets.length === 0) throw new Error("no release assets found in dist/");
  return releaseAssets;
}

function printSummary(summary) {
  process.stdout.write([
    `preview_version=${summary.previewVersion}`,
    `backend_url=${summary.backendUrl}`,
    `release_repo=${summary.releaseRepo}`,
    `dist_tag=${summary.distTag}`,
    `temp_repo=${summary.tempRepo}`,
  ].join("\n") + "\n");
}

async function verifyReleaseAssetsWithRetry(repoRoot, env, attempts = 12, delayMs = 10_000) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("node", ["packages/skill/scripts/verify-release-assets.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        ...env,
      },
    });
    if (result.status === 0) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return;
    }
    lastError = result;
    const combined = `${result.stdout || ""}${result.stderr || ""}`.trim();
    process.stderr.write(`[preview publish] release asset verify attempt ${attempt}/${attempts} failed${combined ? `: ${combined}` : ""}\n`);
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`release asset verification did not pass after ${attempts} attempts${lastError ? "" : ""}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backendUrl = resolvePreviewBackendUrl(process.env, args.backendUrl);
  if (!backendUrl) {
    throw new Error("missing preview backend url. pass --backend-url or set UNBROWSE_PREVIEW_BACKEND_URL / EXPERIMENTS_API_URL / PREVIEW_API_URL");
  }

  requireCommand("bun");
  requireCommand("npm");
  requireCommand("gh");
  requireCommand("git");

  const rootPkg = readJson(path.join(ROOT, "package.json"));
  const skillPkg = readJson(path.join(ROOT, "packages", "skill", "package.json"));
  const versionJson = readJson(path.join(ROOT, "version.json"));
  const baseVersion = rootPkg.version;

  if (baseVersion !== skillPkg.version || baseVersion !== versionJson.version) {
    throw new Error(`version mismatch root=${baseVersion} skill=${skillPkg.version} version.json=${versionJson.version}`);
  }

  const previewVersion = args.version || formatPreviewVersion(baseVersion);
  const tag = `v${previewVersion}`;
  const tempRepo = makeTempRepoCopy(ROOT);

  try {
    writePreviewVersions(tempRepo, previewVersion);

    const summary = {
      previewVersion,
      backendUrl,
      releaseRepo: args.releaseRepo,
      distTag: args.distTag,
      tempRepo,
    };
    printSummary(summary);

    if (args.dryRun) return;

    if (shouldSyncSubmodules(tempRepo)) {
      run("bash", ["scripts/ensure-submodules.sh", "submodules/kuri"], { cwd: tempRepo });
    }
    run("bun", ["install", "--frozen-lockfile"], { cwd: tempRepo });
    run("bun", ["run", "check:skill-md"], { cwd: tempRepo });
    run("bun", ["run", "check:kuri-vendor"], { cwd: tempRepo });
    run("bash", ["scripts/build-binaries.sh", "--all"], {
      cwd: tempRepo,
      env: {
        UNBROWSE_RELEASE_TAG: tag,
        UNBROWSE_RELEASE_REPO: args.releaseRepo,
        UNBROWSE_BUILD_DEFAULT_BACKEND_URL: backendUrl,
        UNBROWSE_BUILD_DEFAULT_PROFILE: "staging",
      },
    });
    const assets = releaseAssetArgs(tempRepo);

    const releaseView = spawnSync("gh", ["release", "view", tag, "--repo", args.releaseRepo], {
      cwd: tempRepo,
      stdio: "ignore",
    });

    if (releaseView.status === 0) {
      run("gh", [
        "release", "upload", tag,
        "--repo", args.releaseRepo,
        ...assets,
        "--clobber",
      ], { cwd: tempRepo });
    } else {
      run("gh", [
        "release", "create", tag,
        "--repo", args.releaseRepo,
        ...assets,
        "--title", tag,
        "--notes", `Preview release ${tag}`,
        "--prerelease",
      ], { cwd: tempRepo });
    }

    await verifyReleaseAssetsWithRetry(tempRepo, {
      UNBROWSE_RELEASE_REPO: args.releaseRepo,
      UNBROWSE_RELEASE_TAG: tag,
    });

    run("npm", ["publish", "--workspace", "packages/skill", "--tag", args.distTag], {
      cwd: tempRepo,
      env: {
        UNBROWSE_ALLOW_SKILL_PUBLISH: "1",
        npm_config_unbrowse_allow_skill_publish: "true",
        UNBROWSE_RELEASE_REPO: args.releaseRepo,
        UNBROWSE_RELEASE_TAG: tag,
        UNBROWSE_BUILD_DEFAULT_BACKEND_URL: backendUrl,
        UNBROWSE_BUILD_DEFAULT_PROFILE: "staging",
      },
    });
  } finally {
    if (!args.keepTemp) rmSync(tempRepo, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[preview publish] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
