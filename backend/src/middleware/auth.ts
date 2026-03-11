import type { Context, Next } from "hono";
import type { Env } from "../types.js";
import { CURRENT_TOS_VERSION, TOS_SUMMARY } from "../tos.js";
import { ensureAgentProfile, recordAgentActivity } from "../services/agents.js";

type AuthEnv = { Bindings: Env; Variables: { agent_id: string } };

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

async function verifyUnkey(rootKey: string, key: string, env?: Env, tags?: string[]): Promise<{ valid: boolean; keyId?: string; code?: string }> {
  // Staging: skip Unkey verification — accept any bearer token
  if (env?.ENVIRONMENT === "staging") {
    return { valid: true, keyId: `staging_${key.slice(0, 8)}` };
  }
  const body: Record<string, unknown> = { key };
  if (tags?.length) body.tags = tags;
  const res = await fetch("https://api.unkey.com/v2/keys.verifyKey", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${rootKey}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { data?: { valid: boolean; keyId?: string; code?: string } };
  return json.data ?? { valid: false, code: "FETCH_ERROR" };
}

/** Verify bearer token and enforce current ToS acceptance. */
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

  // Extract endpoint tag from request path for analytics
  const path = new URL(c.req.url).pathname;
  const endpoint = path.replace(/^\/v1\//, "").split("/")[0] || "unknown";
  const tags = [`endpoint:${endpoint}`];

  // Verify via Unkey v2 REST API (with endpoint tag)
  const result = await verifyUnkey(c.env.UNKEY_ROOT_KEY, token, c.env, tags);

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

  // Enforce ToS acceptance
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

  const pathNoTos = new URL(c.req.url).pathname;
  const epNoTos = pathNoTos.replace(/^\/v1\//, "").split("/")[0] || "unknown";
  const result = await verifyUnkey(c.env.UNKEY_ROOT_KEY, token, c.env, [`endpoint:${epNoTos}`]);
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
      const pathOpt = new URL(c.req.url).pathname;
      const epOpt = pathOpt.replace(/^\/v1\//, "").split("/")[0] || "unknown";
      const result = await verifyUnkey(c.env.UNKEY_ROOT_KEY, token, c.env, [`endpoint:${epOpt}`]);
      if (result.valid && result.keyId) {
        await ensureAgentProfile(c.env, result.keyId);
        c.set("agent_id", result.keyId);
        queueAgentActivity(c, result.keyId);
      }
    }
  }
  await next();
}
