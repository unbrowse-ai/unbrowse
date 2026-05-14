#!/usr/bin/env node

// Fallback stub. The real runtime is the native binary at bin/unbrowse,
// downloaded by scripts/postinstall.mjs from the GitHub release. This file
// only runs if the wrapper could not find that binary, which means either:
//   1. The postinstall download was skipped (CI / UNBROWSE_SKIP_BINARY_DOWNLOAD).
//   2. The download failed (network issue, GH release unavailable).
//   3. The platform is not in SUPPORTED_TARGETS (rare).
//
// In all three cases, the npm tarball intentionally does NOT ship the JS
// runtime, so there is nothing to fall back to. Print a clear repair message
// and exit; users should re-run install or build from source.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const version = readVersion();
const target = `${process.platform}-${process.arch}`;

process.stderr.write(
  [
    "[unbrowse] native binary not installed",
    `[unbrowse] package version: ${version}`,
    `[unbrowse] platform: ${target}`,
    "",
    "[unbrowse] The npm package ships only the native binary downloaded on",
    "[unbrowse] postinstall. Possible causes:",
    "[unbrowse]   - postinstall was skipped (CI / UNBROWSE_SKIP_BINARY_DOWNLOAD)",
    "[unbrowse]   - download failed (check stderr from `npm install`)",
    "[unbrowse]   - platform is not in the prebuilt set",
    "",
    "[unbrowse] Repair:",
    "[unbrowse]   node packages/skill/scripts/postinstall.mjs   # retry download",
    "[unbrowse]   npm uninstall -g unbrowse && npm install -g unbrowse@latest",
    "[unbrowse]   build from source: https://github.com/unbrowse-ai/unbrowse",
  ].join("\n") + "\n",
);
process.exit(1);
