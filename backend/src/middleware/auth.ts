import type { Context, Next } from "hono";
import type { Env } from "../types.js";
import { CURRENT_TOS_VERSION, TOS_SUMMARY } from "../tos.js";
import { ensureAgentProfile, recordAgentActivity } from "../services/agents.js";
import { verifyReleaseManifest } from "../services/release-manifest.js";
import { verifyLocalKey } from "../services/keys.js";
import { lookupUserIdByKey } from "../services/accounts.js";

type AuthEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };

/** Timing-safe string comparison to prevent timing attacks on API key checks. */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

function queueAgentActivity(c: Context<AuthEnv>, agentId: string): void {
  try {
    c.executionCtx.waitUntil(recordAgentActivity(c.env, agentId));
  } catch {
    void recordAgentActivity(c.env, agentId);
  }
}

async function verifyKey(env: Env, key: string): Promise<{ valid: boolean; keyId?: string; code?: string }> {
  // Staging: accept any bearer token for dev convenience
  if (env.ENVIRONMENT === "staging") {
    return { valid: true, keyId: `staging_${key.slice(0, 8)}` };
  }
  const result = await verifyLocalKey(env, key);
  if (!result.valid) {
    return { valid: false, code: "INVALID_KEY" };
  }
  return { valid: true, keyId: result.keyId };
}

export async function bearerAuth(c: Context<AuthEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({
      error: "Missing or invalid Authorization header",
      message: "Sign up at unbrowse.ai to get an API key.",
    }, 401);
  }
  const token = authHeader.slice(7);

  // Legacy admin key (backward compat for existing CLI installs)
  if (c.env.API_KEY && safeCompare(token, c.env.API_KEY)) {
    c.set("agent_id", "__admin__");
    await next();
    return;
  }

  const result = await verifyKey(c.env, token);

  if (!result.valid) {
    return c.json({
      error: "Invalid API key",
      code: result.code,
      message: "Sign up at unbrowse.ai to get an API key.",
    }, 403);
  }

  if (!result.keyId) {
    return c.json({ error: "Invalid API key", code: "MISSING_KEY_ID" }, 401);
  }

  const profile = await ensureAgentProfile(c.env, result.keyId);
  if (profile && profile.tos_accepted_version !== CURRENT_TOS_VERSION) {
    return c.json({
      error: "tos_update_required",
      message: "The Terms of Service have been updated. Please accept the new terms to continue.",
      current_tos_version: CURRENT_TOS_VERSION,
      accepted_version: profile.tos_accepted_version ?? null,
      tos_summary: TOS_SUMMARY,
      tos_url: "https://unbrowse.ai/terms",
    }, 403);
  }

  c.set("agent_id", result.keyId);
  try {
    const userId = await lookupUserIdByKey(c.env, result.keyId);
    if (userId) c.set("user_id", userId);
  } catch {
    // Anonymous keys never have a user_id; lookup failures must not break authed requests.
  }
  queueAgentActivity(c, result.keyId);
  await next();
}

/** Verify bearer token without checking ToS version. Used for /agents/accept-tos and /agents/me. */
export async function bearerAuthNoTos(c: Context<AuthEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({
      error: "Missing or invalid Authorization header",
      message: "Sign up at unbrowse.ai to get an API key.",
    }, 401);
  }
  const token = authHeader.slice(7);

  if (c.env.API_KEY && safeCompare(token, c.env.API_KEY)) {
    c.set("agent_id", "__admin__");
    await next();
    return;
  }

  const result = await verifyKey(c.env, token);
  if (!result.valid) {
    return c.json({ error: "Invalid API key", code: result.code }, 403);
  }
  if (!result.keyId) {
    return c.json({ error: "Invalid API key", code: "MISSING_KEY_ID" }, 401);
  }

  await ensureAgentProfile(c.env, result.keyId);
  c.set("agent_id", result.keyId);
  queueAgentActivity(c, result.keyId);
  await next();
}

/** Optional auth — sets agent_id if a valid key is present, but never rejects. */
export async function optionalAuth(c: Context<AuthEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (c.env.API_KEY && safeCompare(token, c.env.API_KEY)) {
      c.set("agent_id", "__admin__");
    } else {
      const result = await verifyKey(c.env, token);
      if (result.valid && result.keyId) {
        await ensureAgentProfile(c.env, result.keyId);
        c.set("agent_id", result.keyId);
        queueAgentActivity(c, result.keyId);
      }
    }
  }
  await next();
}

/** Returns 426 when the client lacks or fails release-manifest signature verification. Admin keys bypass. */
export async function requireSignedClient(c: Context<AuthEnv>, next: Next) {
  const agentId = c.get("agent_id");
  if (agentId === "__admin__") {
    await next();
    return;
  }

  const manifestHeader = c.req.header("X-Unbrowse-Release-Manifest");
  const signatureHeader = c.req.header("X-Unbrowse-Release-Signature");

  const result = await verifyReleaseManifest(c.env, manifestHeader, signatureHeader);

  if (!result.provided) {
    return c.json({
      error: "client_update_required",
      message: "Your Unbrowse client is outdated and missing release verification. Please update to the latest version.",
      update_command: "npm install -g unbrowse@latest",
      docs: "https://unbrowse.ai/docs/update",
    }, 426);
  }

  if (!result.verified) {
    // If the server's signing secret isn't configured, don't punish the client —
    // the server can't verify, so let the request through.
    if (result.reason === "verification_unconfigured") {
      await next();
      return;
    }
    return c.json({
      error: "client_verification_failed",
      message: "Your Unbrowse client failed release verification. Please update to an official release.",
      reason: result.reason,
      update_command: "npm install -g unbrowse@latest",
      docs: "https://unbrowse.ai/docs/update",
    }, 426);
  }

  await next();
}
