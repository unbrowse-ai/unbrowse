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
  // Preview tags carry a `preview-` prefix on the GitHub release; prod tags
  // carry `v`. The archive name has to mirror whichever prefix was used at
  // build/upload time (see scripts/build-binaries.sh L33 which uses
  // UNBROWSE_RELEASE_TAG). Detect preview by the `-preview.` suffix in the
  // semver itself, which is set by publish-preview-cli.mjs's formatPreviewVersion.
  const prefix = version.includes("-preview.") ? "preview-" : "v";
  return `unbrowse-${prefix}${version}-${target}.tar.gz`;
}

export function buildReleaseAssetUrl(baseUrl, tag, assetName) {
  return `${baseUrl.replace(/\/+$/, "")}/${tag}/${assetName}`;
}
