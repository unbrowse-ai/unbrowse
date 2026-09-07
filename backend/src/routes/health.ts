import { Hono } from "hono";
import type { Env } from "../types.js";
import { kvBackend } from "../services/kv.js";

export const healthRoutes = new Hono<{ Bindings: Env }>();

healthRoutes.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "unbrowse-api",
    environment: c.env.ENVIRONMENT ?? "unknown",
    storage_backend: kvBackend(c.env),
    timestamp: new Date().toISOString(),
  });
});

// /v1/version — public, unauth'd. Serves the deployed artifact identity
// + a signed manifest hash so any user can confirm which version they hit
// and that it was signed by the release pipeline (not a hostile spoof).
//
// Crystallised principle 20260521T194246Z-7ad798e3 (staging-then-prod +
// signed-release-notes). Lewis 2026-05-22: "version tracking thats
// available to the user to understand easily and proper signing
// capabilities".
//
// Data sources (all REAL per the no-stubs principle 20260521T193905Z-
// 61e01c0e):
//   version          UNBROWSE_VERSION wrangler var, set by CI on every
//                    deploy from packages/skill/package.json
//   build_sha        UNBROWSE_BUILD_SHA wrangler var, set by CI from
//                    GITHUB_SHA (or git rev-parse HEAD for manual)
//   deployed_at      UNBROWSE_DEPLOYED_AT wrangler var, ISO8601 stamp
//                    written by deploy.yml on flip
//   channel          "production" | "staging" | "experiments" |
//                    "gate-staging" — from c.env.ENVIRONMENT (always set
//                    per the wrangler [env.*.vars] blocks)
//   signed_manifest_hash  hex(hmac-sha256(version|build_sha|deployed_at,
//                    RELEASE_MANIFEST_SIGNING_SECRET))
//                    Verifiable by the SDK / CLI on first call: re-sign
//                    the same triple, compare; mismatch = artifact was
//                    tampered post-build.
//
// When any of the deploy-time env vars are missing (local dev, fresh
// staging without the CI fields wired), the field surfaces as null
// rather than a placeholder — caller knows the build wasn't through CI.
healthRoutes.get("/v1/version", async (c) => {
  const version = c.env.UNBROWSE_VERSION ?? null;
  const build_sha = c.env.UNBROWSE_BUILD_SHA ?? null;
  const deployed_at = c.env.UNBROWSE_DEPLOYED_AT ?? null;
  const channel = c.env.ENVIRONMENT ?? "unknown";

  let signed_manifest_hash: string | null = null;
  if (version && build_sha && deployed_at && c.env.RELEASE_MANIFEST_SIGNING_SECRET) {
    const payload = `${version}|${build_sha}|${deployed_at}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(c.env.RELEASE_MANIFEST_SIGNING_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    signed_manifest_hash = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  return c.json({
    version,
    build_sha,
    deployed_at,
    channel,
    signed_manifest_hash,
    payload_format: "version|build_sha|deployed_at",
    payload_signed_with: "HMAC-SHA256",
  });
});
