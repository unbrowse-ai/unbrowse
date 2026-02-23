import type { Context, Next } from "hono";
import type { Env } from "../types.js";
import { CURRENT_TOS_VERSION, TOS_SUMMARY } from "../tos.js";
import { getAgent } from "../services/agents.js";

type AuthEnv = { Bindings: Env; Variables: { agent_id: string } };

async function verifyUnkey(rootKey: string, key: string): Promise<{ valid: boolean; keyId?: string; code?: string }> {
  const res = await fetch("https://api.unkey.com/v2/keys.verifyKey", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${rootKey}`,
    },
    body: JSON.stringify({ key }),
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
  if (token === c.env.API_KEY) {
    c.set("agent_id", "__admin__");
    await next();
    return;
  }

  // Verify via Unkey v2 REST API
  const result = await verifyUnkey(c.env.UNKEY_ROOT_KEY, token);

  if (!result.valid) {
    return c.json({
      error: "Invalid API key",
      code: result.code,
      message: "Sign up at unbrowse.ai to get an API key.",
    }, 403);
  }

  // Enforce ToS acceptance
  const profile = await getAgent(c.env, result.keyId!);
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

  c.set("agent_id", result.keyId!);
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

  if (token === c.env.API_KEY) {
    c.set("agent_id", "__admin__");
    await next();
    return;
  }

  const result = await verifyUnkey(c.env.UNKEY_ROOT_KEY, token);
  if (!result.valid) {
    return c.json({ error: "Invalid API key", code: result.code }, 403);
  }

  c.set("agent_id", result.keyId!);
  await next();
}

/** Optional auth — sets agent_id if a valid key is present, but never rejects. */
export async function optionalAuth(c: Context<AuthEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token === c.env.API_KEY) {
      c.set("agent_id", "__admin__");
    } else {
      const result = await verifyUnkey(c.env.UNKEY_ROOT_KEY, token);
      if (result.valid) {
        c.set("agent_id", result.keyId!);
      }
    }
  }
  await next();
}
