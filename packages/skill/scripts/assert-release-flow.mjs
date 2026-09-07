#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(scriptDir);
const repoRoot = path.resolve(packageRoot, "..", "..");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function fail(message) {
  console.error(`[skill publish guard] ${message}`);
  process.exit(1);
}

const rootPkg = readJson(path.join(repoRoot, "package.json"));
const skillPkg = readJson(path.join(packageRoot, "package.json"));
const versionJson = readJson(path.join(repoRoot, "version.json"));

const rootVersion = rootPkg.version;
const skillVersion = skillPkg.version;
const repoVersion = typeof versionJson === "string" ? versionJson : versionJson.version;

if (rootVersion !== skillVersion || rootVersion !== repoVersion) {
  fail(
    `version mismatch root=${rootVersion} skill=${skillVersion} version.json=${repoVersion}. Run root release flow: bun run release`,
  );
}

const allowDirectPublish =
  process.env.UNBROWSE_ALLOW_SKILL_PUBLISH === "1" ||
  process.env.npm_config_unbrowse_allow_skill_publish === "true" ||
  process.env.npm_config_unbrowse_allow_skill_publish === "1" ||
  process.env.CI === "true";

if (!allowDirectPublish) {
  fail(
    "direct publish from packages/skill is blocked. Use repo root release flow: bun run release. If you explicitly need a local npm publish after a synced bump, run bun run publish:cli from repo root.",
  );
}

if (process.argv.includes("--check-npm")) {
  const name = skillPkg.name;
  try {
    const publishedVersion = execFileSync("npm", ["view", `${name}@${skillVersion}`, "version"], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (publishedVersion === skillVersion) {
      fail(`${name}@${skillVersion} is already on npm. Bump via bun run release before publishing again.`);
    }
  } catch {
    // npm view non-zero means version not found; publish may proceed
  }
}

console.log(`[skill publish guard] ok ${skillPkg.name}@${skillVersion}`);
