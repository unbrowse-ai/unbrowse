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
  setKeyDelegation,
  clearKeyFunding,
  clearKeyWallet,
  creditKeyWalletBalance,
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
import { getDelegationSessionKeyAddress } from "../services/delegation-settlement.js";

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
//
// Contract 900714e4 (founder allowlist): verified founder emails are
// surfaced with tier="founder" and unlimited=true so frontends can render
// "unlimited" instead of a synthetic 9.0e15 number. The underlying
// balance_uc still rides on the UserCreditBalance shape so existing
// clients keep working.
accountRoutes.get("/account/credits", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const { getUserCreditBalance } = await import("../services/user-credits.js");
  const { isFounderUser } = await import("../services/founder-allowlist.js");
  const [balance, founder] = await Promise.all([
    getUserCreditBalance(c.env, userId),
    isFounderUser(c.env, userId),
  ]);
  if (founder) {
    return c.json({ ...balance, tier: "founder", unlimited: true, balance: "unlimited" });
  }
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

// --- Non-custodial delegated funding lane (design: bench/design-gaps/delegation-design.md) ---
//
// Phase-1 foundation: pure binding/admin. NO x402, NO payment, NO signing, NO
// fund movement. The wallet itself created+funded the escrow and registered the
// session key on-chain (steps a/b in §3); these routes only RECORD the bounded,
// expiring delegation against the key so a later phase can sign within the cap.

// POST /v1/account/keys/:keyId/delegation -- bind a non-custodial delegation.
// Owner-auth via the same userOwnsKey guard the funding routes use; the wallet
// claim is additionally hijack-hardened inside setKeyDelegation (refuses a
// wallet already owned by another key).
accountRoutes.post("/account/keys/:keyId/delegation", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const keyId = c.req.param("keyId");
  if (!keyId || !(await userOwnsKey(c, userId, keyId))) {
    return c.json({ error: "not_found", message: "No such key on this account." }, 404);
  }

  let body: {
    wallet?: unknown;
    escrow?: unknown;
    session_key_address?: unknown;
    cap_uc?: unknown;
    expires_at_slot?: unknown;
  };
  try {
    body = JSON.parse(await c.req.text()) as typeof body;
  } catch {
    return c.json({ error: "invalid_input", message: "Body must be valid JSON." }, 400);
  }

  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const escrow = typeof body.escrow === "string" ? body.escrow.trim() : "";
  const sessionKey = typeof body.session_key_address === "string" ? body.session_key_address.trim() : "";
  const expiresAtSlot = typeof body.expires_at_slot === "string" ? body.expires_at_slot.trim() : "";
  if (!wallet || !escrow || !sessionKey || !expiresAtSlot) {
    return c.json(
      {
        error: "invalid_input",
        message: "wallet, escrow, session_key_address, expires_at_slot must be non-empty strings.",
      },
      400,
    );
  }
  if (typeof body.cap_uc !== "number" || !Number.isFinite(body.cap_uc) || body.cap_uc <= 0) {
    return c.json({ error: "invalid_input", message: "cap_uc must be a positive number (micro-cents)." }, 400);
  }

  const bound = await setKeyDelegation(c.env, keyId, {
    wallet,
    escrow,
    session_key_address: sessionKey,
    cap_uc: Math.floor(body.cap_uc),
    expires_at_slot: expiresAtSlot,
  });
  if (!bound) {
    // The wallet is already owned by a DIFFERENT key — hijack refusal.
    return c.json(
      { error: "wallet_already_bound", message: "That wallet is already bound to another key." },
      409,
    );
  }
  return c.json({ keyId, funding: bound });
});

// DELETE /v1/account/keys/:keyId/delegation -- revoke the delegation binding
// (revocation path 2). Clears the funding record AND the wallet ownership index
// the delegation bind wrote, so the wallet is free to be re-delegated.
accountRoutes.delete("/account/keys/:keyId/delegation", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const keyId = c.req.param("keyId");
  if (!keyId || !(await userOwnsKey(c, userId, keyId))) {
    return c.json({ error: "not_found", message: "No such key on this account." }, 404);
  }
  await clearKeyFunding(c.env, keyId);
  await clearKeyWallet(c.env, keyId);
  return c.json({ ok: true, keyId, funding: null });
});

// GET /v1/account/delegation/session-key -- discovery for the non-custodial
// delegation lane. Returns the PLATFORM's delegation session-key PUBLIC address
// so a user can register it to their OWN escrow before binding a delegation.
// Light auth only (same bearer guard as the rest of /account/*): this is a read
// of a PUBLIC key — the address is derived from the held secret, the secret is
// NEVER returned or logged. When the lane isn't configured: {ready:false}, 200.
accountRoutes.get("/account/delegation/session-key", async (c) => {
  const address = await getDelegationSessionKeyAddress(c.env);
  if (!address) {
    return c.json({ ready: false, reason: "delegation_not_configured" });
  }
  return c.json({ session_key_address: address, ready: true });
});

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// POST /v1/account/keys/:keyId/deposit -- x402-gated wallet → key-balance top-up.
//
// Money-IN: the caller's WALLET pays USDC (signs ONE x402), and on a confirmed
// payment the platform credits this key's spendable `balance_uc`. The key then
// SPENDS that balance on every later call (the always-on debit lane in
// debitKeyFunding) — the platform never pays for the call and never holds the
// user's wallet key.
//
// Flow (standard x402 facilitated payment, reusing the EXISTING verify/settle
// path — no hand-written tx code):
//   1. No X-PAYMENT header  -> 402 with an exact-scheme accept entry priced at
//      `amount_usd`, paid to the platform treasury USDC ATA.
//   2. X-PAYMENT present     -> handleFlexPaymentAuthorized verifies + settles
//      the on-chain payment (exact lane via PayAI), then the executeFn credits
//      `balance_uc` by the paid amount and returns the new balance.
//
// Requires the key to already carry a kind:"wallet" funding binding (the wallet
// recorded as owner-of-record); deposit funds that bound wallet key.
accountRoutes.post("/account/keys/:keyId/deposit", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  const keyId = c.req.param("keyId");
  if (!keyId || !(await userOwnsKey(c, userId, keyId))) {
    return c.json({ error: "not_found", message: "No such key on this account." }, 404);
  }

  // The deposit only makes sense for a wallet-bound key (the balance belongs to
  // a wallet of record). Bind the wallet first via POST .../funding {kind:"wallet"}.
  const funding = await getKeyFunding(c.env, keyId);
  if (!funding || funding.kind !== "wallet") {
    return c.json({
      error: "wallet_binding_required",
      message: "Deposit requires a wallet-bound key. Bind a wallet first via POST /v1/account/keys/:keyId/funding {kind:'wallet'}.",
    }, 400);
  }

  let body: { amount_usd?: unknown };
  try {
    body = JSON.parse(await c.req.text()) as typeof body;
  } catch {
    return c.json({ error: "invalid_input", message: "Body must be valid JSON." }, 400);
  }
  const amountUsd = typeof body.amount_usd === "number" ? body.amount_usd : NaN;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return c.json({ error: "invalid_input", message: "amount_usd must be a positive number." }, 400);
  }
  const amountUc = Math.round(amountUsd * 1_000_000);

  const { platformRecipientUsdcAta } = await import("../services/flex-facilitator.js");
  let platformAta: string;
  try {
    platformAta = platformRecipientUsdcAta(c.env);
  } catch (err) {
    return c.json({ error: "deposit_unavailable", reason: (err as Error).message }, 503);
  }

  const paymentHeader = c.req.header("X-PAYMENT");
  if (!paymentHeader) {
    // No proof yet — return the 402 with an exact-scheme accept entry the wallet
    // signs (USDC → platform treasury ATA), priced at the requested amount.
    const { PAYAI_FEEPAYER_DEFAULT } = await import("../services/flex-route-helpers.js");
    const feePayer = c.env.PAYAI_FEEPAYER_PUBKEY?.trim() || PAYAI_FEEPAYER_DEFAULT;
    const terms = {
      x402Version: 2 as const,
      error: "Payment Required",
      resource: {
        url: c.req.url,
        description: `Deposit $${amountUsd.toFixed(6)} into key ${keyId} balance`,
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact" as const,
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          amount: String(Math.max(1, amountUc)),
          asset: USDC_MINT_MAINNET,
          payTo: platformAta,
          maxTimeoutSeconds: 300,
          extra: { feePayer, facilitator: "https://facilitator.payai.network" },
        },
      ],
    };
    return c.json(terms, 402, { "X-Payment-Required": JSON.stringify(terms) });
  }

  // X-PAYMENT present — verify + settle the on-chain payment via the EXISTING
  // facilitated path, then credit the key balance on confirmed settlement.
  const { handleFlexPaymentAuthorized } = await import("../services/flex-route-helpers.js");
  return handleFlexPaymentAuthorized(c, paymentHeader, {
    executeFn: async () => {
      const credited = await creditKeyWalletBalance(c.env, keyId, amountUc);
      if (!credited.ok) {
        return new Response(
          JSON.stringify({ error: "credit_failed", reason: credited.reason }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          keyId,
          deposited_uc: amountUc,
          balance_uc: credited.balance_uc,
          wallet: credited.wallet,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
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
  const { withCache, sponsorCacheKey, buildCacheHeaders, safeExecutionCtx } = await import(
    "../services/kv-cache.js"
  );

  const agentId = c.get("agent_id");
  // Same date bucket the middleware uses (UTC YYYY-MM-DD).
  const dateStr = new Date().toISOString().slice(0, 10);

  // W17 cache wrap. Key = cache:sponsor:<agentId>:<UTC-date>. agentId is
  // the hash of the bearer key (already used as a public identifier in
  // the splits/ledger surface — same kind of public ID used by
  // `routes/agents.ts`), NOT the bearer key itself, NOT the wallet
  // pubkey. UTC-date in the key shape rolls the cache at midnight UTC,
  // matching the middleware's bucket boundary so we never serve a
  // yesterday-balance into today. Short 30s TTL because per-agent
  // spend changes every paid call; SWR DISABLED — staleness here would
  // mean the agent sees a wrong "remaining" number and could over-
  // request, defeating the sponsor cap. Heb 6:18 — the seal must match
  // the truth; the witness must be fresh.
  const noCacheHdr = c.req.header("cache-control")?.toLowerCase().includes("no-cache") ?? false;
  type SponsorPayload = {
    enabled: boolean;
    cap_daily_usd: number;
    spent_today_usd: number;
    remaining_today_usd: number;
    global_cap_daily_usd: number;
    global_spent_today_usd: number;
  };
  const cacheResult = await withCache<SponsorPayload>(
    c.env,
    sponsorCacheKey(agentId, dateStr),
    30,
    { bypass: noCacheHdr, staleWhileRevalidate: false, ctx: safeExecutionCtx(c) },
    async () => {
      const enabled = sponsorWalletReady(c.env);
      const capDailyUsd = sponsorCapDailyUsd(c.env);
      const globalCapDailyUsd = sponsorGlobalCapDailyUsd(c.env);
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
      return {
        enabled,
        cap_daily_usd: capDailyUsd,
        spent_today_usd: spentTodayUsd,
        remaining_today_usd: remainingTodayUsd,
        global_cap_daily_usd: globalCapDailyUsd,
        global_spent_today_usd: globalSpentUc / 1_000_000,
      };
    },
  );

  const headers = buildCacheHeaders(cacheResult);
  for (const [k, v] of Object.entries(headers)) c.header(k, v);
  return c.json(cacheResult.value);
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

// ---------------------------------------------------------------------------
// POST /v1/account/payment-provider
//
// Wave 2 of .claude/add-a-payment-provider-choice-prompt-to-unbrowse.
// Syncs the CLI-chosen payment-provider (from ~/.unbrowse/config.json
// `payment.provider`) up to the backend so `agent.wallet_provider`
// reflects the rail the user picked. Different from POST
// /v1/account/wallet (updateAgentWallet) because this route accepts a
// provider WITHOUT requiring a wallet_address — for pay.sh + lobster.cash
// the wallet lives inside the provider's own CLI, not in the agent
// record. For external_solana + privy_embedded the wallet binding
// flows through a separate path (updateAgentWallet via
// /v1/auth/privy/start for Privy; `unbrowse wallet` for external).
// ---------------------------------------------------------------------------
const ALLOWED_PROVIDERS = new Set([
  "pay_sh",
  "lobster_cash",
  "external_solana",
  "privy_embedded",
  "privy_embedded_solana",
  "skip",
]);

accountRoutes.post("/account/payment-provider", async (c) => {
  const agentId = c.get("agent_id");
  if (!agentId) return c.json({ error: "agent_required" }, 401);

  let body: { provider?: string };
  try {
    body = (await c.req.json()) as { provider?: string };
  } catch {
    return c.json({ error: "invalid_json", message: "Body must be JSON with a `provider` field" }, 400);
  }

  const provider = (body.provider ?? "").trim();
  if (!provider) {
    return c.json({ error: "provider_required", message: "Body must include `provider`" }, 400);
  }
  if (!ALLOWED_PROVIDERS.has(provider)) {
    return c.json(
      {
        error: "provider_not_allowed",
        message: `Provider must be one of: ${Array.from(ALLOWED_PROVIDERS).join(", ")}`,
        received: provider,
      },
      400,
    );
  }

  const { updateAgentPaymentProvider } = await import("../services/agents.js");
  const result = await updateAgentPaymentProvider(c.env, agentId, provider);
  return c.json({
    agent_id: agentId,
    wallet_provider: result.profile.wallet_provider ?? null,
    wallet_address: result.profile.wallet_address ?? null,
  });
});

// ---------------------------------------------------------------------------
// Web2 subscription billing routes (contract 9474c6ab)
//
// Three account-bound routes that hide x402 entirely behind a Stripe
// subscription. They wrap the existing helpers in services/stripe.ts and
// soft-fail with 503 `billing_not_configured` when STRIPE_SECRET_KEY is unset
// so a worker without Stripe wired keeps booting cleanly.
// ---------------------------------------------------------------------------

function billingNotConfigured(c: Context<AccountEnv>) {
  return c.json(
    {
      error: "billing_not_configured",
      message:
        "Stripe is not wired on this worker (STRIPE_SECRET_KEY missing). Web2 billing is unavailable; use the x402 lane.",
    },
    503,
  );
}

// POST /v1/account/billing-subscribe-url -- { plan_id?, return_url? }
// Returns a Stripe Checkout URL the caller can open to subscribe.
accountRoutes.post("/account/billing-subscribe-url", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  if (!c.env.STRIPE_SECRET_KEY) return billingNotConfigured(c);

  let body: { plan_id?: string; return_url?: string; tier?: "pro" | "metered" | "base" };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }

  const { createCheckoutSession } = await import("../services/stripe.js");
  const user = await getUserById(c.env, userId);
  const email = user?.email ?? `${userId}@users.unbrowse.ai`;
  const returnUrl =
    body.return_url ??
    `${c.env.PUBLIC_FRONTEND_URL ?? "https://unbrowse.ai"}/billing/success`;

  // `plan_id` is the canonical contract field. It maps to Stripe price_id
  // when the caller knows the exact price, or to the tier shorthand
  // ("pro" / "metered" / "base") which `createCheckoutSession` resolves
  // against the configured price ids.
  const planId = body.plan_id?.trim();
  const isTier = planId === "pro" || planId === "metered" || planId === "base";
  try {
    const result = await createCheckoutSession(c.env, userId, email, returnUrl, {
      priceId: isTier ? undefined : planId || undefined,
      tier: isTier ? (planId as "pro" | "metered" | "base") : body.tier,
    });
    return c.json({
      checkout_url: result.url,
      session_id: null,
      plan_id: planId ?? result.tier,
      price_id: result.price_id,
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error("[account/billing-subscribe-url]", msg);
    return c.json({ error: "checkout_failed", message: msg }, 500);
  }
});

// POST /v1/account/billing-portal-url -- returns Stripe customer-portal URL.
accountRoutes.post("/account/billing-portal-url", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  if (!c.env.STRIPE_SECRET_KEY) return billingNotConfigured(c);

  let body: { return_url?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }
  const returnUrl =
    body.return_url ?? `${c.env.PUBLIC_FRONTEND_URL ?? "https://unbrowse.ai"}/billing`;

  const { createPortalSession } = await import("../services/stripe.js");
  try {
    const { url } = await createPortalSession(c.env, userId, returnUrl);
    return c.json({ portal_url: url });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "no_customer") {
      return c.json(
        {
          error: "no_customer",
          message:
            "No Stripe customer record yet — subscribe via /v1/account/billing-subscribe-url first.",
        },
        404,
      );
    }
    console.error("[account/billing-portal-url]", msg);
    return c.json({ error: "portal_failed", message: msg }, 500);
  }
});

// GET /v1/account/billing-status -- declarative subscription + usage snapshot.
// Returns `subscription_active: false` with nulls when no subscription is
// found; never 404 — the absent-subscription case is a normal state.
accountRoutes.get("/account/billing-status", async (c) => {
  const userId = c.get("user_id");
  if (!userId) return accountRequired(c);
  if (!c.env.STRIPE_SECRET_KEY) return billingNotConfigured(c);

  const { readSubFromKV } = await import("../services/stripe.js");
  let sub: Awaited<ReturnType<typeof readSubFromKV>> = null;
  try {
    sub = await readSubFromKV(c.env, userId);
  } catch (err) {
    console.warn("[account/billing-status] readSubFromKV threw:", (err as Error).message);
  }

  if (!sub || sub.status === "none") {
    return c.json({
      subscription_active: false,
      plan_name: null,
      monthly_limit_usd: null,
      consumed_usd: null,
      remaining_usd: null,
      renewal_date: null,
      payment_method_present: false,
      auto_refill_enabled: false,
    });
  }

  // Read current-period consumption from the same Neon table peekUsage uses.
  // peekUsage is internal to stripe.ts; mirror its public surface via the
  // exported `subscriptionAdmits` helper which already returns `consumed`.
  const { subscriptionAdmits } = await import("../services/stripe.js");
  let consumed = 0;
  try {
    const admit = await subscriptionAdmits(
      c.env,
      c as unknown as Parameters<typeof subscriptionAdmits>[1],
    );
    if (typeof admit.consumed === "number") consumed = admit.consumed;
  } catch (err) {
    console.warn(
      "[account/billing-status] subscriptionAdmits threw:",
      (err as Error).message,
    );
  }

  const active = sub.status === "active" || sub.status === "trialing";
  const quota = sub.quota; // declared in units (USD-cents semantics owned by Stripe price metadata)
  const monthlyLimitUsd = quota / 100;
  const consumedUsd = consumed / 100;
  const remainingUsd = Math.max(0, monthlyLimitUsd - consumedUsd);
  const renewalDate =
    sub.currentPeriodEnd && sub.currentPeriodEnd > 0
      ? new Date(sub.currentPeriodEnd * 1000).toISOString()
      : null;

  return c.json({
    subscription_active: active,
    plan_name: sub.priceId || null,
    monthly_limit_usd: monthlyLimitUsd,
    consumed_usd: consumedUsd,
    remaining_usd: remainingUsd,
    renewal_date: renewalDate,
    payment_method_present: !!sub.paymentMethod,
    auto_refill_enabled: sub.overageAllowed,
  });
});
