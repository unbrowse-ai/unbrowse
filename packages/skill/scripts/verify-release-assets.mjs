#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELEASE_METADATA_ASSETS,
  SUPPORTED_TARGETS,
  buildBinaryArchiveName,
  buildReleaseAssetUrl,
  getReleaseAssetConfig,
} from "./release-assets.mjs";

// Explicit operator override — mirrors the UNBROWSE_ALLOW_SKILL_PUBLISH escape in
// the sibling guard assert-release-flow.mjs. The npm JS-CLI package and the
// standalone cross-platform binary GH-release assets are independent artifacts;
// when a runner cannot produce the binary archives (e.g. the gitea mac-mini's
// known build-cli-binary gap), this asset check would block the npm publish even
// though the package itself is correct. Default behaviour is UNCHANGED (every
// asset is still verified); the skip fires only when the operator has explicitly
// allowed a skill-only publish. Visible, never silent.
const allowSkillOnlyPublish =
  process.env.UNBROWSE_ALLOW_SKILL_PUBLISH === "1" ||
  process.env.npm_config_unbrowse_allow_skill_publish === "true" ||
  process.env.npm_config_unbrowse_allow_skill_publish === "1";
if (allowSkillOnlyPublish && process.env.UNBROWSE_REQUIRE_RELEASE_ASSETS !== "1") {
  console.log("[release-assets] skip — UNBROWSE_ALLOW_SKILL_PUBLISH set (skill-only publish; binary GH-release assets not required for this publish)");
  process.exit(0);
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { tag, repo, baseUrl, version } = getReleaseAssetConfig(packageRoot);
const assets = [...SUPPORTED_TARGETS.map((target) => buildBinaryArchiveName(version, target)), ...RELEASE_METADATA_ASSETS];

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
