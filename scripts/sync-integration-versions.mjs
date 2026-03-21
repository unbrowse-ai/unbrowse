#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const checkOnly = process.argv.includes("--check");

const rootVersion = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
).version;

const mismatches = [];
const touched = [];

function syncJsonVersion(relPath) {
  const absPath = resolve(root, relPath);
  if (!existsSync(absPath)) return;
  const pkg = JSON.parse(readFileSync(absPath, "utf8"));
  if (pkg.version === rootVersion) return;
  if (checkOnly) {
    mismatches.push(`${relPath}: ${pkg.version} != ${rootVersion}`);
    return;
  }
  pkg.version = rootVersion;
  writeFileSync(absPath, `${JSON.stringify(pkg, null, 2)}\n`);
  touched.push(relPath);
}

function syncPackageLock(relPath) {
  const absPath = resolve(root, relPath);
  if (!existsSync(absPath)) return;
  const lock = JSON.parse(readFileSync(absPath, "utf8"));
  const currentTop = lock.version;
  const currentRoot = lock.packages?.[""]?.version;
  if (currentTop === rootVersion && currentRoot === rootVersion) return;
  if (checkOnly) {
    mismatches.push(`${relPath}: ${currentTop ?? "missing"} / ${currentRoot ?? "missing"} != ${rootVersion}`);
    return;
  }
  lock.version = rootVersion;
  if (lock.packages?.[""]) lock.packages[""].version = rootVersion;
  writeFileSync(absPath, `${JSON.stringify(lock, null, 2)}\n`);
  touched.push(relPath);
}

function syncTomlVersion(relPath) {
  const absPath = resolve(root, relPath);
  if (!existsSync(absPath)) return;
  const source = readFileSync(absPath, "utf8");
  const next = source.replace(
    /^version\s*=\s*"[^"]+"$/m,
    `version = "${rootVersion}"`,
  );
  if (next === source) return;
  if (checkOnly) {
    const current = source.match(/^version\s*=\s*"([^"]+)"$/m)?.[1] ?? "missing";
    mismatches.push(`${relPath}: ${current} != ${rootVersion}`);
    return;
  }
  writeFileSync(absPath, next);
  touched.push(relPath);
}

function syncText(relPath, fromPattern, replacementFactory) {
  const absPath = resolve(root, relPath);
  if (!existsSync(absPath)) return;
  const source = readFileSync(absPath, "utf8");
  const match = source.match(fromPattern);
  if (!match) return;
  if (match[1] === rootVersion) return;
  if (checkOnly) {
    mismatches.push(`${relPath}: ${match[1]} != ${rootVersion}`);
    return;
  }
  const next = source.replace(fromPattern, replacementFactory(rootVersion));
  writeFileSync(absPath, next);
  touched.push(relPath);
}

syncJsonVersion("integrations/elizaos/package.json");
syncJsonVersion("integrations/mcp/package.json");
syncJsonVersion("integrations/openclaw/package.json");
syncJsonVersion("integrations/vercel-ai-sdk/package.json");
syncPackageLock("integrations/elizaos/package-lock.json");
syncPackageLock("integrations/mcp/package-lock.json");
syncPackageLock("integrations/openclaw/package-lock.json");
syncTomlVersion("integrations/hermes/pyproject.toml");
syncTomlVersion("integrations/langchain/pyproject.toml");
syncText(
  "integrations/mcp/src/index.ts",
  /version:\s*"([^"]+)"/,
  (version) => `version: "${version}"`,
);

if (mismatches.length > 0) {
  console.error("Integration versions out of sync:");
  for (const mismatch of mismatches) console.error(`- ${mismatch}`);
  process.exit(1);
}

if (checkOnly) {
  console.log("Integration versions are in sync.");
} else if (touched.length > 0) {
  console.log(`Synced integration versions to ${rootVersion}:`);
  for (const file of touched) console.log(`- ${file}`);
} else {
  console.log(`Integration versions already at ${rootVersion}.`);
}
