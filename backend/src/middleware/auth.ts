import type { Context, Next } from "hono";
import type { Env } from "../types.js";
import { CURRENT_TOS_VERSION, TOS_SUMMARY } from "../tos.js";
import { ensureAgentProfile, recordAgentActivity } from "../services/agents.js";
import { verifyReleaseManifest } from "../services/release-manifest.js";
import { verifyLocalKey } from "../services/keys.js";
import { lookupUserIdByKey } from "../services/accounts.js";

type AuthEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string; anon_index_contribution?: boolean } };

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

  // Nuclear kill-switch (2026-05-18 security rotation): if ALL_KEYS_REVOKED is
  // set, every key — including admin tokens that came from the env — is rejected
  // with a re-register pointer. Reversible by clearing the env var. See
  // types.ts::Env.ALL_KEYS_REVOKED for the rotation policy.
  const allKeysRevoked = ((c.env as { ALL_KEYS_REVOKED?: string }).ALL_KEYS_REVOKED ?? "").toLowerCase();
  if (allKeysRevoked === "1" || allKeysRevoked === "true") {
    return c.json({
      error: "all_keys_rotated",
      message:
        "All API keys were rotated on 2026-05-18 for security. Please sign in at https://unbrowse.ai/login to mint a new key. Old CLI installs need to re-run `unbrowse setup`.",
      rotation_url: "https://unbrowse.ai/login",
      rotated_at: "2026-05-18T00:00:00.000Z",
    }, 401);
  }

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

  // ALL_KEYS_REVOKED kill-switch (mirrors bearerAuth). Reject before any KV lookup.
  const allKeysRevokedNoTos = ((c.env as { ALL_KEYS_REVOKED?: string }).ALL_KEYS_REVOKED ?? "").toLowerCase();
  if (allKeysRevokedNoTos === "1" || allKeysRevokedNoTos === "true") {
    return c.json({
      error: "all_keys_rotated",
      message:
        "All API keys were rotated on 2026-05-18 for security. Please sign in at https://unbrowse.ai/login to mint a new key.",
      rotation_url: "https://unbrowse.ai/login",
    }, 401);
  }

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

/** Optional auth — sets agent_id if a valid key is present, but never rejects.
 * Honors the ALL_KEYS_REVOKED kill-switch by skipping agent_id assignment
 * (routes still work anonymously; no one looks authenticated until they
 * re-register). */
export async function optionalAuth(c: Context<AuthEnv>, next: Next) {
  const authHeader = c.req.header("Authorization");
  const allKeysRevokedOpt = ((c.env as { ALL_KEYS_REVOKED?: string }).ALL_KEYS_REVOKED ?? "").toLowerCase();
  const killed = allKeysRevokedOpt === "1" || allKeysRevokedOpt === "true";
  if (!killed && authHeader?.startsWith("Bearer ")) {
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

/** Stable attribution id when no agent identity and no env wallet is configured —
 *  contributions still land in the index under this sentinel rather than being lost. */
export const GLOBAL_INDEX_AGENT_ID = "__global_index__";

/**
 * Contribution-write auth — the bearer-OPTIONAL, wallet-is-the-real-auth pattern.
 *
 * Bearer/API-key is just the web2 convenience wrapper over identity; the real
 * gate on these routes is the paired `requireSignedClient` (proves an official
 * unbrowse client). So: if a valid key is present, attribute to that agent; if
 * not, attribute the contribution to the GLOBAL INDEX WALLET (env
 * UNBROWSE_GLOBAL_INDEX_WALLET, else the __global_index__ sentinel). Never 401s
 * on a missing key — the index ALWAYS grows, a wallet-less user still contributes
 * (credited to the global index). `anon_index_contribution` is set so handlers
 * can tell a real agent from a global-index fallback when they need to.
 */
export async function indexContributorAuth(c: Context<AuthEnv>, next: Next) {
  await optionalAuth(c, async () => {});
  if (!c.get("agent_id")) {
    const envWallet = (c.env as { UNBROWSE_GLOBAL_INDEX_WALLET?: string }).UNBROWSE_GLOBAL_INDEX_WALLET?.trim();
    c.set("agent_id", envWallet && envWallet.length > 0 ? envWallet : GLOBAL_INDEX_AGENT_ID);
    c.set("anon_index_contribution", true);
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
