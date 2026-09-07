#!/usr/bin/env node
// W13.1 — vendor guard for the utls-proxy CONNECT daemon.
//
// Eph 6:11 — "Put on the WHOLE armor." A release that ships missing the
// utls-proxy vendor for the CURRENT platform is fine (the runtime falls
// through to iproyal-only with no TLS spoof). But the npm tarball MUST at
// least be SHAPED to ship one binary somewhere, or every platform will
// silently downgrade. This guard surfaces the gap as evidence — never
// hard-fails so a release can still ship when the build host couldn't
// cross-compile for a target.
//
// Mirrors the kuri vendor guard pattern (assert-kuri-vendor.mjs) but
// LENIENT (warn, don't exit 1) per the honest-fall-through rule.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.dirname(scriptDir);
const vendorRoot = path.join(packageRoot, "vendor", "utls-proxy");

const TARGETS = [
  { id: "darwin-arm64", bin: "utls-proxy-darwin-arm64" },
  { id: "darwin-amd64", bin: "utls-proxy-darwin-amd64" },
  { id: "linux-amd64", bin: "utls-proxy-linux-amd64" },
  { id: "linux-arm64", bin: "utls-proxy-linux-arm64" },
];
const MAX_BYTES = 8 * 1024 * 1024;

function warn(msg) {
  console.warn(`[utls-proxy vendor guard] WARN ${msg}`);
}
function ok(msg) {
  console.log(`[utls-proxy vendor guard] ok ${msg}`);
}

if (!existsSync(vendorRoot)) {
  warn(
    `vendor/utls-proxy/ missing — runtime will fall through to iproyal-only (no TLS spoof). Build via 'bash submodules/utls-proxy/build.sh' before publish.`,
  );
  process.exit(0); // honest fall-through, not a publish blocker
}

const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
if (!Array.isArray(packageJson.files) || !packageJson.files.includes("vendor/utls-proxy")) {
  warn(
    'packages/skill/package.json does not list "vendor/utls-proxy" in files[]. Tarball will NOT carry the binary even though dist/ has one.',
  );
}

let foundAny = false;
let oversized = [];
for (const target of TARGETS) {
  const p = path.join(vendorRoot, target.bin);
  if (!existsSync(p)) {
    warn(`missing ${target.id} binary at ${p}`);
    continue;
  }
  const st = statSync(p);
  if (!st.isFile()) {
    warn(`${target.id} entry is not a regular file`);
    continue;
  }
  if (st.size > MAX_BYTES) {
    oversized.push(`${target.id}=${st.size}`);
  }
  ok(`${target.id} ${st.size} bytes`);
  foundAny = true;
}

if (oversized.length > 0) {
  warn(`oversize binaries (>8MB budget): ${oversized.join(" ")}`);
}
if (!foundAny) {
  warn(`vendor/utls-proxy/ exists but contains NO usable target binaries.`);
}
process.exit(0);
