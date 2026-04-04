#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_METADATA_ASSETS,
  SUPPORTED_TARGETS,
  buildReleaseAssetUrl,
  getReleaseAssetConfig,
} from "./release-assets.mjs";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { tag, repo, baseUrl } = getReleaseAssetConfig(packageRoot);
const assets = [...SUPPORTED_TARGETS.map((target) => `unbrowse-${target}`), ...RELEASE_METADATA_ASSETS];

async function assertReachable(assetName) {
  const url = buildReleaseAssetUrl(baseUrl, tag, assetName);
  const verifyUrl = `${url}${url.includes("?") ? "&" : "?"}verify=${Date.now()}`;
  const res = await fetch(verifyUrl, {
    method: "GET",
    headers: {
      Range: "bytes=0-0",
      "User-Agent": "unbrowse-release-asset-check",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
    redirect: "follow",
  });
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`${assetName} returned HTTP ${res.status} from ${verifyUrl}`);
  }
}

try {
  for (const assetName of assets) {
    await assertReachable(assetName);
  }
  console.log(`[release-assets] ok ${repo} ${tag} (${assets.length} assets)`);
} catch (error) {
  console.error(`[release-assets] ${(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
}
