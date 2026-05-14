import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import { getUserById, listKeysForUser, getAccountPreferences, setAccountPreferences } from "../services/accounts.js";
import { listSkills } from "../services/marketplace.js";
import { getAgent } from "../services/agents.js";

type AccountEnv = { Bindings: Env; Variables: { agent_id: string; user_id?: string } };

export const accountRoutes = new Hono<AccountEnv>();

accountRoutes.use("/account/*", bearerAuth);

function accountRequired(c: Context<AccountEnv>) {
  return c.json({
    error: "account_required",
    message: "This endpoint requires an account-bound API key. Run `unbrowse register --email …`.",
  }, 403);
}

// GET /v1/account/me
accountRoutes.get("/account/me", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  const user = await getUserById(c.env, userId);
  if (!user) return c.json({ error: "user_not_found" }, 500);

  const keys = await listKeysForUser(c.env, userId);
  // TODO(slice-2): owner_user_id on skills — until then count is 0
  const skillsCount = (await listSkills(c.env)).filter((s) => (s as { owner_user_id?: string }).owner_user_id === userId).length;

  // Flex onboarding state lives on the AgentProfile keyed by agent_id (the
  // SHA-256 hash of the calling API key). Surface it here so the frontend
  // `/account` page can render the three onboarding CTAs (wallet, escrow,
  // session key) without a second round-trip.
  const agentId = c.get("agent_id");
  const agent = agentId ? await getAgent(c.env, agentId) : null;

  return c.json({
    user_id: user.user_id,
    email: user.email,
    created_at: user.created_at,
    verified_at: user.verified_at ?? null,
    keys_count: keys.length,
    skills_count: skillsCount,
    wallet_address: agent?.wallet_address ?? null,
    wallet_provider: agent?.wallet_provider ?? null,
    flex_escrow_address: agent?.flex_escrow_address ?? null,
    flex_session_key_address: agent?.flex_session_key_address ?? null,
    flex_facilitator: agent?.flex_facilitator ?? null,
  });
});

// GET /v1/account/keys
accountRoutes.get("/account/keys", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  const keyIds = await listKeysForUser(c.env, userId);
  // TODO(account-meta): plumb created_at via inverse index
  return c.json({ keys: keyIds.map((id) => ({ keyId: id })) });
});

// GET /v1/account/skills
accountRoutes.get("/account/skills", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  // TODO(slice-2): owner_user_id on skills — returns [] until then
  const skills = (await listSkills(c.env)).filter((s) => (s as { owner_user_id?: string }).owner_user_id === userId);
  return c.json({ skills });
});

// GET /v1/account/preferences
accountRoutes.get("/account/preferences", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const prefs = await getAccountPreferences(c.env, userId);
  return c.json(prefs);
});

// PATCH /v1/account/preferences
accountRoutes.patch("/account/preferences", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  let body: Record<string, unknown> = {};
  try {
    const text = await c.req.text();
    if (text.trim().length > 0) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_input", message: "Body must be valid JSON." }, 400);
  }

  if ("share_pointers" in body && typeof body.share_pointers !== "boolean") {
    return c.json({ error: "invalid_input", message: "share_pointers must be a boolean." }, 400);
  }

  const patch: Partial<{ share_pointers: boolean }> = {};
  if (typeof body.share_pointers === "boolean") patch.share_pointers = body.share_pointers;

  const prefs = await setAccountPreferences(c.env, userId, patch);
  return c.json(prefs);
});

/**
 * GET /v1/account/sponsor-status
 *
 * Authenticated agent-level snapshot of how much of the platform sponsor
 * credit the agent has left today, plus the org-wide rollup. Same bearer
 * auth as `/v1/account/*` — the calling agent_id is read from the verified
 * key, so an agent cannot peek at another agent's bucket by querying this
 * endpoint.
 *
 * USD math: the middleware tracks running spend in µ¢ (1_000_000 µ¢ = $1)
 * and caps in USD. Conversions live here so the MCP / settings client gets a
 * single ready-to-render snapshot — no client-side arithmetic on micro-cents.
 *
 * Powers the `unbrowse_settings` MCP tool's `sponsor_status` field and the
 * local server's `/v1/settings` surface.
 */
accountRoutes.get("/account/sponsor-status", async (c) => {
  const { sponsorWalletReady, sponsorCapDailyUsd, sponsorGlobalCapDailyUsd } =
    await import("../middleware/sponsor.js");
  const { statsKV } = await import("../services/kv.js");

  const agentId = c.get("agent_id");
  const enabled = sponsorWalletReady(c.env);
  const capDailyUsd = sponsorCapDailyUsd(c.env);
  const globalCapDailyUsd = sponsorGlobalCapDailyUsd(c.env);

  // Same date bucket the middleware uses (UTC YYYY-MM-DD).
  const dateStr = new Date().toISOString().slice(0, 10);
  const agentKey = `sponsor:agent:${agentId}:${dateStr}`;
  const globalKey = `sponsor:global:${dateStr}`;

  let agentSpentUc = 0;
  let globalSpentUc = 0;
  try {
    const kv = statsKV(c.env);
    const [agentRaw, globalRaw] = await Promise.all([
      kv.get(agentKey) as Promise<string | null>,
      kv.get(globalKey) as Promise<string | null>,
    ]);
    const ap = agentRaw ? Number.parseInt(agentRaw, 10) : 0;
    const gp = globalRaw ? Number.parseInt(globalRaw, 10) : 0;
    if (Number.isFinite(ap) && ap >= 0) agentSpentUc = ap;
    if (Number.isFinite(gp) && gp >= 0) globalSpentUc = gp;
  } catch {
    // Best-effort: missing KV (test env without seeded data) reads as zero.
  }

  const spentTodayUsd = agentSpentUc / 1_000_000;
  const remainingTodayUsd = Math.max(0, capDailyUsd - spentTodayUsd);

  return c.json({
    enabled,
    cap_daily_usd: capDailyUsd,
    spent_today_usd: spentTodayUsd,
    remaining_today_usd: remainingTodayUsd,
    global_cap_daily_usd: globalCapDailyUsd,
    global_spent_today_usd: globalSpentUc / 1_000_000,
  });
});
