#!/usr/bin/env node

/**
 * postinstall-ping: opt-in install telemetry beacon.
 *
 * Default OFF. Set UNBROWSE_TELEMETRY=1 to enable. POSTs a minimal
 * {event:"npm_install", version, platform, arch, ts} body to the
 * Worker telemetry route. NO PII: never includes $HOME, hostname,
 * username, IP, cwd, or any env beyond process.platform + process.arch.
 *
 * Invoked at the tail of scripts/postinstall.mjs; failures are swallowed
 * so a flaky network can never block an npm install.
 *
 * Wave-2.1 of the end-to-end funnel tracking plan (Layer 3 of 9).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { randomUUID } from "node:crypto";

// Opt-in gate. Default OFF per CLAUDE.md plan constraint.
if (process.env.UNBROWSE_TELEMETRY !== "1") {
  process.exit(0);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");

let version = "unknown";
try {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (typeof pkg.version === "string") version = pkg.version;
} catch {
  // Best-effort. A missing/corrupt package.json should never fail install.
}

const endpoint =
  process.env.UNBROWSE_TELEMETRY_URL ?? "https://beta-api.unbrowse.ai/v1/telemetry/install";

// Minimal, PII-free payload. install_id is a fresh per-install UUID so the
// route's existing schema is satisfied; we never persist it on disk and
// never join it back to a user identity.
const payload = JSON.stringify({
  install_id: randomUUID(),
  source: "npm_postinstall",
  skill: "unbrowse",
  skill_version: version,
  status: "installed",
  created_at: new Date().toISOString(),
  properties: {
    event: "npm_install",
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
  },
});

try {
  const url = new URL(endpoint);
  const req = https.request(
    {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "User-Agent": `unbrowse-postinstall-ping/${version}`,
      },
      timeout: 3_000,
    },
    (res) => {
      // Drain the response so the socket can close cleanly. Status code
      // doesn't matter; telemetry is fire-and-forget.
      res.on("data", () => {});
      res.on("end", () => {});
    },
  );
  req.on("error", () => {
    // Network failure must never break an install.
  });
  req.on("timeout", () => {
    req.destroy();
  });
  req.write(payload);
  req.end();
} catch {
  // Any synchronous URL/parse error is swallowed.
}
