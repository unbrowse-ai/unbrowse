#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

// win-x64 added 2026-05-26 — Bun handles `--target=bun-windows-x64`
// natively, postinstall picks 'win32' via the platform map (see
// postinstall.mjs), and src/kuri/client.ts already picks kuri.exe and
// the win-x64 vendor path. The kuri-windows-cross-build workflow stages
// kuri.exe; build-kuri-binaries.mjs picks it up at release time. Runtime
// verification (Chrome detection, console buffering) still needs a
// Windows machine — track separately.
export const SUPPORTED_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win-x64"];
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
  // The upload step (scripts/build-binaries.sh + .github/workflows/release.yml)
  // always names archives `unbrowse-v<VERSION>-<target>.tar.gz` regardless of
  // preview-ness. Earlier the comment here referenced a `preview-` prefix that
  // a hypothetical `publish-preview-cli.mjs` was supposed to use, but no such
  // path exists in the actual upload chain. Always use `v`.
  return `unbrowse-v${version}-${target}.tar.gz`;
}

export function buildReleaseAssetUrl(baseUrl, tag, assetName) {
  return `${baseUrl.replace(/\/+$/, "")}/${tag}/${assetName}`;
}

// --- Windows-aware binary naming -------------------------------------------
// The compiled unbrowse binary is `unbrowse` on darwin/linux but `unbrowse.exe`
// on Windows: bun emits `.exe` for `--target=bun-windows-x64`, the release
// tarball packs it at the archive root as `unbrowse.exe`, and Windows refuses
// to exec a file without the extension. Both the postinstall (which extracts
// the tarball member and installs it into bin/) and the wrapper (which execs
// bin/unbrowse[.exe]) must agree on the name, so the decision lives here.
//
// Accepts either a Node `process.platform` value (`win32`) or a release target
// id (`win-x64`) — anything that starts with `win` is treated as Windows.
export function isWindowsPlatform(platformOrTarget) {
  return typeof platformOrTarget === "string" && platformOrTarget.startsWith("win");
}

export function unbrowseBinaryName(platformOrTarget) {
  return isWindowsPlatform(platformOrTarget) ? "unbrowse.exe" : "unbrowse";
}
