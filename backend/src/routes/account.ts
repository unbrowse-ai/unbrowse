import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import {
  getUserById,
  listKeysForUser,
  getAccountPreferences,
  setAccountPreferences,
  bindKeyToUser,
  unbindKeyFromUser,
} from "../services/accounts.js";
import {
  createLocalKey,
  revokeLocalKey,
  getKeyMeta,
  getKeyFunding,
  setKeyFunding,
  clearKeyFunding,
  type KeyFundingInput,
} from "../services/keys.js";
import { listSkills, getSkill, invalidateSkillListCaches } from "../services/marketplace.js";
import { reindexSkill, removeSkillFromIndex } from "../services/discovery.js";
import { skillsKV, statsKV } from "../services/kv.js";
import {
  type DomainClaimBinding,
  type DomainTakedownRecord,
} from "../services/domain-claim.js";
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

// GET /v1/account/credits -- user-level credit balance (D1b, wave-3).
// Reads the Stripe-tier grant ledger keyed by user_id. Independent of
// the agent-keyed credits.ts subsidy pool which stays for free-tier
// agent credits.
accountRoutes.get("/account/credits", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const { getUserCreditBalance } = await import("../services/user-credits.js");
  const balance = await getUserCreditBalance(c.env, userId);
  return c.json(balance);
});

// GET /v1/account/keys -- list keys with name, created_at, revoked_at, funding
accountRoutes.get("/account/keys", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  const keyIds = await listKeysForUser(c.env, userId);
  const keys = await Promise.all(
    keyIds.map(async (id) => {
      const [meta, funding] = await Promise.all([
        getKeyMeta(c.env, id),
        getKeyFunding(c.env, id),
      ]);
      return {
        keyId: id,
        name: meta?.name ?? "",
        created_at: meta?.created_at ?? null,
        revoked_at: meta?.revoked_at ?? null,
        funding: funding ?? null,
      };
    }),
  );
  return c.json({ keys });
});

async function userOwnsKey(c: Context<AccountEnv>, userId: string, keyId: string): Promise<boolean> {
  const keyIds = await listKeysForUser(c.env, userId);
  return keyIds.includes(keyId);
}

// POST /v1/account/keys -- create a new named API key bound to this account
accountRoutes.post("/account/keys", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  let name = "default";
  try {
    const text = await c.req.text();
    if (text.trim().length > 0) {
      const body = JSON.parse(text) as { name?: unknown };
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 64) {
          return c.json({ error: "invalid_input", message: "name must be a non-empty string up to 64 chars." }, 400);
        }
        name = body.name.trim();
      }
    }
  } catch {
    return c.json({ error: "invalid_input", message: "Body must be valid JSON." }, 400);
  }

  const { keyId, key, meta } = await createLocalKey(c.env, name);
  await bindKeyToUser(c.env, keyId, userId);
  // One-shot: the plaintext key is returned exactly once and never stored.
  return c.json({
    keyId,
    key,
    name: meta.name,
    created_at: meta.created_at,
    message: "Store this key now. It is shown once and cannot be retrieved again.",
  }, 201);
});

// DELETE /v1/account/keys/:keyId -- revoke a key (idempotent)
accountRoutes.delete("/account/keys/:keyId", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const keyId = c.req.param("keyId");
  if (!keyId) return c.json({ error: "invalid_input", message: "keyId required." }, 400);
  if (!(await userOwnsKey(c, userId, keyId))) {
    return c.json({ error: "not_found", message: "No such key on this account." }, 404);
  }

  const revoked = await revokeLocalKey(c.env, keyId);
  await unbindKeyFromUser(c.env, keyId, userId);
  if (!revoked) {
    return c.json({ error: "not_found", message: "Key metadata missing; unbound from account." }, 404);
  }
  return c.json({ ok: true, keyId, revoked: true });
});

// POST /v1/account/keys/:keyId/rotate -- issue a replacement, revoke the old
accountRoutes.post("/account/keys/:keyId/rotate", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const oldKeyId = c.req.param("keyId");
  if (!oldKeyId) return c.json({ error: "invalid_input", message: "keyId required." }, 400);
  if (!(await userOwnsKey(c, userId, oldKeyId))) {
    return c.json({ error: "not_found", message: "No such key on this account." }, 404);
  }

  const oldMeta = await getKeyMeta(c.env, oldKeyId);
  const name = oldMeta?.name ?? "rotated";
  const { keyId, key, meta } = await createLocalKey(c.env, name);
  await bindKeyToUser(c.env, keyId, userId);
  await revokeLocalKey(c.env, oldKeyId);
  await unbindKeyFromUser(c.env, oldKeyId, userId);
  return c.json({
    keyId,
    key,
    name: meta.name,
    created_at: meta.created_at,
    rotated_from: oldKeyId,
    message: "Store this key now. The previous key is revoked.",
  }, 201);
});

// --- L6: API key wrapping x402 (per-key funding binding) ---

// GET /v1/account/keys/:keyId/funding
accountRoutes.get("/account/keys/:keyId/funding", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const keyId = c.req.param("keyId");
  if (!keyId || !(await userOwnsKey(c, userId, keyId))) {
    return c.json({ error: "not_found", message: "No such key on this account." }, 404);
  }
  const funding = await getKeyFunding(c.env, keyId);
  return c.json({ keyId, funding: funding ?? null });
});

// POST /v1/account/keys/:keyId/funding -- bind a wallet or credit budget so
// calls authenticated by this key auto-pay paid skills (no per-call signing).
accountRoutes.post("/account/keys/:keyId/funding", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const keyId = c.req.param("keyId");
  if (!keyId || !(await userOwnsKey(c, userId, keyId))) {
    return c.json({ error: "not_found", message: "No such key on this account." }, 404);
  }

  let body: { kind?: unknown; wallet?: unknown; budget_uc?: unknown };
  try {
    body = JSON.parse(await c.req.text()) as typeof body;
  } catch {
    return c.json({ error: "invalid_input", message: "Body must be valid JSON." }, 400);
  }

  let funding: KeyFundingInput;
  if (body.kind === "wallet") {
    if (typeof body.wallet !== "string" || body.wallet.trim().length < 8) {
      return c.json({ error: "invalid_input", message: "wallet must be a wallet address string." }, 400);
    }
    funding = { kind: "wallet", wallet: body.wallet.trim() };
  } else if (body.kind === "credit") {
    if (typeof body.budget_uc !== "number" || !Number.isFinite(body.budget_uc) || body.budget_uc <= 0) {
      return c.json({ error: "invalid_input", message: "budget_uc must be a positive number (micro-cents)." }, 400);
    }
    funding = { kind: "credit", budget_uc: Math.floor(body.budget_uc) };
  } else {
    return c.json({ error: "invalid_input", message: "kind must be 'wallet' or 'credit'." }, 400);
  }

  const bound = await setKeyFunding(c.env, keyId, funding);
  return c.json({ keyId, funding: bound });
});

// DELETE /v1/account/keys/:keyId/funding -- unbind, restore manual payment
accountRoutes.delete("/account/keys/:keyId/funding", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const keyId = c.req.param("keyId");
  if (!keyId || !(await userOwnsKey(c, userId, keyId))) {
    return c.json({ error: "not_found", message: "No such key on this account." }, 404);
  }
  await clearKeyFunding(c.env, keyId);
  return c.json({ ok: true, keyId, funding: null });
});

// GET /v1/account/skills
accountRoutes.get("/account/skills", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);

  // TODO(slice-2): owner_user_id on skills — returns [] until then
  const skills = (await listSkills(c.env)).filter((s) => (s as { owner_user_id?: string }).owner_user_id === userId);
  return c.json({ skills });
});

// PATCH /v1/account/skills/:skillId -- owner-controlled public/private
// visibility. Account-scoped (bearerAuth only, no signed-client gate) so the
// website can toggle it; the CLI/programmatic path stays on
// PATCH /v1/skills/:id. Same index-toggle semantics as that route.
accountRoutes.patch("/account/skills/:skillId", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const skillId = c.req.param("skillId");
  if (!skillId) return c.json({ error: "invalid_input", message: "skillId required." }, 400);

  let body: { visibility?: unknown };
  try {
    body = JSON.parse(await c.req.text()) as { visibility?: unknown };
  } catch {
    return c.json({ error: "invalid_input", message: "Body must be valid JSON." }, 400);
  }
  if (body.visibility !== "public" && body.visibility !== "private") {
    return c.json({ error: "invalid_input", message: "visibility must be 'public' or 'private'." }, 400);
  }

  const skill = await getSkill(c.env, skillId);
  if (!skill) return c.json({ error: "not_found", message: "Skill not found." }, 404);
  if ((skill as { owner_user_id?: string }).owner_user_id !== userId) {
    return c.json({ error: "forbidden", message: "You do not own this skill." }, 403);
  }

  const prev = skill.visibility ?? "public";
  if (prev !== body.visibility) {
    skill.visibility = body.visibility;
    skill.updated_at = new Date().toISOString();
    await skillsKV(c.env).put(`skill:${skillId}`, JSON.stringify(skill));
    if (body.visibility === "private") {
      await removeSkillFromIndex(c.env, skill.skill_id, skill.domain).catch((err) =>
        console.warn(`[account] removeSkillFromIndex failed for ${skill.skill_id}:`, (err as Error).message),
      );
    } else {
      await reindexSkill(c.env, skill).catch((err) =>
        console.warn(`[account] reindexSkill failed for ${skill.skill_id}:`, (err as Error).message),
      );
    }
    await invalidateSkillListCaches(c.env).catch(() => {});
  }
  return c.json({ skill_id: skillId, visibility: skill.visibility ?? "public" });
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

/**
 * GET /v1/account/private-domains
 *
 * Returns the calling agent's domain claims (DNS-TXT verified wallet
 * bindings that earn owner-share on paid execute) AND domain takedowns
 * (DNS-TXT verified opt-outs that suppress future skill publish).
 *
 * Auth: same bearer auth as the rest of `/account/*`. The agent_id is
 * read off the verified key, so an agent cannot enumerate another
 * agent's records by querying this endpoint.
 *
 * Implementation note: there is no per-user secondary index yet — claims
 * and takedowns are keyed by domain, not user. The route reads the full
 * `domain-wallet:*` and `domain-optout:*` prefixes via the EdbKV index
 * (one call each — values are inline in the index after the first cold
 * load) and filters by `verified_by_agent_id`. Fine for the current
 * scale (hundreds of domain records). If the corpus grows past O(10K)
 * domains, add an `agent-domains:<agent_id>` reverse index stamped
 * during verify and switch this route to read that.
 *
 * Powers a "My Private Domains" section on /account and the future
 * `unbrowse account private-domains` CLI command.
 */
accountRoutes.get("/account/private-domains", async (c) => {
  const agentId = c.get("agent_id");
  const kv = statsKV(c.env);

  const [optoutsRaw, claimsRaw] = await Promise.all([
    kv.listWithValues("domain-optout:").catch(() => []),
    kv.listWithValues("domain-wallet:").catch(() => []),
  ]);

  const takedowns: Array<{ domain: string; opted_out_at: string; reason?: string }> = [];
  for (const entry of optoutsRaw) {
    let record: DomainTakedownRecord;
    try {
      record = JSON.parse(entry.value) as DomainTakedownRecord;
    } catch {
      continue;
    }
    if (record.verified_by_agent_id !== agentId) continue;
    if (typeof record.domain !== "string" || !record.domain) continue;
    takedowns.push({
      domain: record.domain,
      opted_out_at: record.verified_at,
      reason: record.reason,
    });
  }

  const claims: Array<{ domain: string; wallet_address: string; verified_at: string }> = [];
  for (const entry of claimsRaw) {
    let record: DomainClaimBinding;
    try {
      record = JSON.parse(entry.value) as DomainClaimBinding;
    } catch {
      continue;
    }
    if (record.verified_by_agent_id !== agentId) continue;
    if (typeof record.domain !== "string" || !record.domain) continue;
    claims.push({
      domain: record.domain,
      wallet_address: record.wallet_address,
      verified_at: record.verified_at,
    });
  }

  // Deterministic order: alphabetically by domain so the UI / CLI render
  // consistently between requests.
  takedowns.sort((a, b) => a.domain.localeCompare(b.domain));
  claims.sort((a, b) => a.domain.localeCompare(b.domain));

  return c.json({ takedowns, claims, agent_id: agentId });
});
