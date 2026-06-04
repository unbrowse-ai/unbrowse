#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashFile,
  hasVendoredBinaries,
  readSourceSha,
  readVendorManifest,
  resolveSourceDir,
  supportedTargets,
  upstreamBranch,
  upstreamRepoUrl,
} from "./lib/kuri-vendor.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(scriptDir);
const repoRoot = path.resolve(packageRoot, "..", "..");
const vendorRoot = path.join(packageRoot, "vendor", "kuri");

function fail(message) {
  console.error(`[kuri vendor guard] ${message}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const manifest = readVendorManifest(vendorRoot);
if (!manifest) fail("missing vendor/kuri/manifest.json");

if (!hasVendoredBinaries(vendorRoot)) {
  fail("missing baked Kuri binaries. Run node packages/skill/scripts/build-kuri-binaries.mjs");
}

if (manifest.repo_url !== upstreamRepoUrl) {
  fail(`unexpected Kuri repo ${manifest.repo_url ?? "(missing)"}. Expected ${upstreamRepoUrl}`);
}

if (manifest.branch !== upstreamBranch) {
  fail(`unexpected Kuri branch ${manifest.branch ?? "(missing)"}. Expected ${upstreamBranch}`);
}

for (const target of supportedTargets) {
  const outFile = path.join(vendorRoot, target.id, target.bin);
  const expectedHash = manifest.binaries?.[target.id]?.sha256;
  if (!expectedHash) {
    fail(`manifest missing sha256 for ${target.id}`);
  }
  const actualHash = hashFile(outFile);
  if (actualHash !== expectedHash) {
    fail(`hash mismatch for ${target.id}: manifest=${expectedHash} actual=${actualHash}`);
  }
}

const sourceDir = resolveSourceDir(packageRoot, repoRoot);
const sourceSha = readSourceSha(sourceDir);
if (sourceSha && manifest.source_sha !== sourceSha) {
  fail(
    `vendored Kuri is stale: manifest=${manifest.source_sha ?? "(missing)"} source=${sourceSha}. Rebuild baked binaries before pack/publish.`,
  );
}

const packageJson = readJson(path.join(packageRoot, "package.json"));
if (!Array.isArray(packageJson.files) || !packageJson.files.includes("vendor/kuri")) {
  fail('packages/skill/package.json must ship baked Kuri via files:["vendor/kuri"]');
}

console.log(
  `[kuri vendor guard] ok ${manifest.branch}@${manifest.source_sha} with ${supportedTargets.length} baked targets`,
);
