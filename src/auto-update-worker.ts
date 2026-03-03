#!/usr/bin/env bun
/**
 * Auto-update worker — runs as a detached background process.
 * Self-contained: no imports from the rest of the codebase.
 *
 * 1. Checks GitHub for the latest commit SHA
 * 2. Compares against stored SHA in ~/.unbrowse/config.json
 * 3. Downloads + extracts tarball if outdated
 * 4. Runs bun install
 * 5. Updates stored SHA
 *
 * All errors are caught — exits silently on any failure.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { homedir } from "os";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".unbrowse");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const SKILL_DIR = join(HOME, ".agents", "skills", "unbrowse");
const REPO = "unbrowse-ai/unbrowse";

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

async function main(): Promise<void> {
  // 1. Check GitHub for latest commit SHA
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/commits/main`,
    {
      headers: { Accept: "application/vnd.github.sha" },
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) return;
  const sha = (await res.text()).trim();

  // 2. Compare against stored SHA
  const config = readConfig();
  if (config.update_sha === sha) return; // already up to date

  // 3. Download tarball
  const tarRes = await fetch(
    `https://github.com/${REPO}/archive/main.tar.gz`,
    { signal: AbortSignal.timeout(60_000) }
  );
  if (!tarRes.ok) return;

  // 4. Extract to temp dir and copy over
  const tmpDir = execSync("mktemp -d", { encoding: "utf-8" }).trim();
  try {
    const tarPath = join(tmpDir, "update.tar.gz");
    writeFileSync(tarPath, Buffer.from(await tarRes.arrayBuffer()));
    execSync(`tar xzf "${tarPath}" -C "${tmpDir}"`);

    // Copy new files over, preserving local-only files
    const srcDir = join(tmpDir, "unbrowse-main");
    execSync(
      `rsync -a --exclude node_modules --exclude .env --exclude traces "${srcDir}/" "${SKILL_DIR}/"`,
      { stdio: "ignore" }
    );

    // 5. Install/update dependencies
    try {
      execSync("bun install --frozen-lockfile", { cwd: SKILL_DIR, stdio: "ignore", timeout: 60_000 });
    } catch {
      execSync("bun install", { cwd: SKILL_DIR, stdio: "ignore", timeout: 60_000 });
    }
  } finally {
    execSync(`rm -rf "${tmpDir}"`);
  }

  // 6. Store new SHA (read-merge-write to preserve other fields)
  const freshConfig = readConfig();
  freshConfig.update_sha = sha;
  freshConfig.last_updated_at = new Date().toISOString();
  writeConfig(freshConfig);
}

main().catch(() => process.exit(0));
