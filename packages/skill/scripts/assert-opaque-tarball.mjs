#!/usr/bin/env node
// Strict gate: the npm tarball MUST be opaque.
// Runtime ships as the platform binary attached to the GitHub release. The
// npm package is a thin wrapper that downloads that binary on postinstall.
// Anything under dist/ or any .ts file in the tarball leaks bundled JS or
// TypeScript source to every npm consumer (`npm pack && tar -xf`).
//
// Wire into: precommit, publish:cli, publish:cli:preview.
// Override only with UNBROWSE_ALLOW_BUNDLED_TARBALL=1 (do not commit).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

// Files allowed under dist/ as bootstrap stubs. Currently none; dist/ must
// be absent entirely from the tarball. Add an exception here only with PR
// justification.
const DIST_ALLOWLIST = new Set();

function packDryRun() {
  // --ignore-scripts: skip prepack so its stdout doesn't pollute --json output.
  const stdout = execFileSync(
    "npm",
    [
      "pack",
      "--dry-run",
      "--json",
      "--ignore-scripts",
      "--workspace",
      "packages/skill",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  // npm sometimes prefixes the JSON with notice lines; find the first `[`.
  const startIdx = stdout.indexOf("[");
  if (startIdx < 0) {
    throw new Error("npm pack --dry-run --json: no JSON array in stdout");
  }
  const parsed = JSON.parse(stdout.slice(startIdx));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("npm pack --dry-run --json returned no packages");
  }
  if (!Array.isArray(parsed[0].files)) {
    throw new Error("npm pack --dry-run --json: missing files[]");
  }
  return parsed[0].files.map((entry) => entry.path);
}

function main() {
  if (process.env.UNBROWSE_ALLOW_BUNDLED_TARBALL === "1") {
    console.warn("[opaque-tarball] OVERRIDE: UNBROWSE_ALLOW_BUNDLED_TARBALL=1, skipping gate");
    return;
  }

  // STATIC check: package.json files[] must not declare dist or *.ts entries.
  // Independent of on-disk state, so the gate is honest even on a fresh clone.
  const skillPkgPath = path.join(REPO_ROOT, "packages", "skill", "package.json");
  const skillPkg = JSON.parse(readFileSync(skillPkgPath, "utf8"));
  const declaredFiles = Array.isArray(skillPkg.files) ? skillPkg.files : [];
  const staticOffenders = declaredFiles.filter((entry) => {
    if (typeof entry !== "string") return false;
    if (entry === "dist" || entry.startsWith("dist/")) return true;
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) return true;
    return false;
  });

  // DYNAMIC check: npm pack --dry-run produces the actual file list.
  const files = packDryRun();
  const dynamicOffenders = [];
  for (const file of files) {
    if (file.startsWith("dist/") && !DIST_ALLOWLIST.has(file)) {
      dynamicOffenders.push({ file, reason: "dist/ files leak bundled JS implementation" });
      continue;
    }
    if (file.endsWith(".ts") || file.endsWith(".tsx")) {
      dynamicOffenders.push({ file, reason: "TypeScript source leaks implementation" });
    }
  }

  if (staticOffenders.length > 0 || dynamicOffenders.length > 0) {
    console.error("[opaque-tarball] FAIL: forbidden entries in npm tarball");
    if (staticOffenders.length > 0) {
      console.error("  packages/skill/package.json files[] declares:");
      for (const entry of staticOffenders) console.error(`    - ${entry}`);
    }
    if (dynamicOffenders.length > 0) {
      console.error("  npm pack --dry-run would include:");
      for (const { file, reason } of dynamicOffenders) console.error(`    - ${file}  (${reason})`);
    }
    console.error("");
    console.error("[opaque-tarball] The runtime must ship as the opaque platform binary attached to");
    console.error("[opaque-tarball] the GitHub release. Remove `dist` from packages/skill/package.json");
    console.error("[opaque-tarball] files[] and have scripts/postinstall.mjs fetch the GH-release binary.");
    console.error("[opaque-tarball] Override (DO NOT commit): UNBROWSE_ALLOW_BUNDLED_TARBALL=1");
    process.exit(1);
  }

  console.log(`[opaque-tarball] OK: ${files.length} tarball entries, 0 source-leak offenders`);
}

main();
