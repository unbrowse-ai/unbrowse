#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SUPPORTED_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
export const RELEASE_METADATA_ASSETS = ["release-manifest.json", "release-manifest.sig"];

export function readPackageVersion(packageRoot) {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  return pkg.version;
}

export function getReleaseAssetConfig(packageRoot) {
  const version = readPackageVersion(packageRoot);
  const repo = process.env.UNBROWSE_RELEASE_REPO || "unbrowse-ai/unbrowse";
  const tag = process.env.UNBROWSE_RELEASE_TAG || `v${version}`;
  const baseUrl = process.env.UNBROWSE_RELEASE_BASE_URL || `https://github.com/${repo}/releases/download`;
  return { version, repo, tag, baseUrl };
}

export function buildBinaryArchiveName(version, target) {
  return `unbrowse-v${version}-${target}.tar.gz`;
}

export function buildReleaseAssetUrl(baseUrl, tag, assetName) {
  return `${baseUrl.replace(/\/+$/, "")}/${tag}/${assetName}`;
}
