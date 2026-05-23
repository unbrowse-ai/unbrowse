// /v1/session/* -- exec-token mint + admin CI build registration.
//
// Principle: anti-reverse-engineering Wave 1 (Lewis 2026-05-22).
// See services/exec-token.ts for the full design.

import { Hono } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import {
  issueExecToken,
  registerBuild,
  EXEC_TOKEN_DEFAULT_TTL_SECONDS,
} from "../services/exec-token.js";

export const sessionRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// POST /v1/session/exec-token
// Caller: any agent with a valid bearer API key.
// Body: { build_sha, deployed_at, ttl_seconds? }
// Returns: { token, exp, agent_id, build_sha, deployed_at } OR
//          { error_code, reason } with 401/400.
sessionRoutes.post("/session/exec-token", bearerAuth, async (c) => {
  type Body = { build_sha?: string; deployed_at?: string; ttl_seconds?: number };
  const body: Body = await c.req.json<Body>().catch(() => ({}) as Body);

  const agent_id = c.get("agent_id");
  if (!agent_id) {
    return c.json({ error_code: "no_agent", reason: "bearerAuth failed to attach agent_id" }, 401);
  }
  if (!body.build_sha || !body.deployed_at) {
    return c.json({
      error_code: "missing_identity",
      reason: "body must carry build_sha + deployed_at (read from your CLI's bundled build-info OR from a GET /v1/version round-trip)",
      next_step: "GET /v1/version, then resend with the build_sha + deployed_at from the response",
    }, 400);
  }

  const result = await issueExecToken(c.env, {
    agent_id,
    build_sha: body.build_sha,
    deployed_at: body.deployed_at,
    ttl_seconds: body.ttl_seconds,
  });

  if (!result.ok) {
    const status = result.error_code === "secret_unconfigured" ? 500 : 403;
    return c.json({
      error_code: result.error_code,
      reason: result.reason,
      next_step: result.error_code === "unknown_build"
        ? "run `unbrowse update` to get a CI-signed build; reverse-engineered or hand-built binaries cannot acquire tokens"
        : null,
    }, status);
  }

  return c.json({
    token: result.token,
    exp: result.exp,
    agent_id: result.agent_id,
    build_sha: result.build_sha,
    deployed_at: result.deployed_at,
    ttl_seconds_default: EXEC_TOKEN_DEFAULT_TTL_SECONDS,
    usage: "include this token as 'X-Unbrowse-Session: <token>' on every marketplace call (/v1/search, /v1/skills, etc).",
  });
});

// POST /v1/internal/register-build -- ADMIN-gated CI build registration.
// Caller: GitHub Actions release workflow with ADMIN_KEY.
// Body: { build_sha, deployed_at, version?, channel? }
//
// Records a known-CI tuple into KV so exec-token issuance for that tuple
// works. Without this registration, the (build_sha, deployed_at) tuple
// is unknown to the server and exec-token issuance refuses (which is
// what makes reverse-engineered builds unable to acquire tokens).
sessionRoutes.post("/internal/register-build", async (c) => {
  const adminKey = c.req.header("X-Admin-Key") ?? "";
  if (!adminKey || adminKey !== (c.env.ADMIN_KEY ?? "")) {
    return c.json({ error_code: "admin_required", reason: "X-Admin-Key header must match ADMIN_KEY env" }, 403);
  }
  type RegBody = { build_sha?: string; deployed_at?: string; version?: string; channel?: string };
  const body: RegBody = await c.req.json<RegBody>().catch(() => ({}) as RegBody);
  if (!body.build_sha || !body.deployed_at) {
    return c.json({ error_code: "missing_identity", reason: "build_sha + deployed_at required" }, 400);
  }
  await registerBuild(c.env, body.build_sha, body.deployed_at, {
    version: body.version,
    channel: body.channel,
    registered_by: "ci",
  });
  return c.json({ ok: true, registered: { build_sha: body.build_sha, deployed_at: body.deployed_at } });
});
