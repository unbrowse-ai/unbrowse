import { Hono } from "hono";
import type { Env } from "../types.js";
import { bearerAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
  getBalance,
  getPoolStatus,
  grantCredits,
  initSubsidyPool,
  checkSelfSustaining,
  debitCredits,
} from "../services/credits.js";

export const creditRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

creditRoutes.use("/credits/*", rateLimit({ limit: 30, window: 60, prefix: "credits" }));

// Feature gate — all credit endpoints return 404 when disabled
creditRoutes.use("/credits/*", async (c, next) => {
  if (c.env.CREDITS_ENABLED !== "1") {
    return c.json({ error: "Credits system not enabled", hint: "Set CREDITS_ENABLED=1" }, 404);
  }
  await next();
});

// GET /v1/credits/balance — authenticated agent gets own credit balance
creditRoutes.get("/credits/balance", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  try {
    const balance = await getBalance(c.env, agentId);
    if (!balance) {
      return c.json({
        agent_id: agentId,
        granted_uc: 0,
        earned_uc: 0,
        consumed_uc: 0,
        balance_uc: 0,
        is_self_sustaining: false,
      });
    }
    return c.json(balance);
  } catch (err) {
    console.error("[credits/balance] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/credits/debit — authenticated agent debits own credits for API usage
creditRoutes.post("/credits/debit", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  const { amount_uc } = await c.req.json<{ amount_uc: number }>();
  if (!amount_uc || amount_uc <= 0) {
    return c.json({ error: "amount_uc must be a positive number" }, 400);
  }
  try {
    const result = await debitCredits(c.env, agentId, amount_uc);
    if (!result.success) {
      return c.json({ error: "insufficient_balance", balance_uc: result.remaining_balance_uc }, 402);
    }
    const balance = await getBalance(c.env, agentId);
    return c.json({
      success: true,
      balance_uc: balance?.balance_uc ?? result.remaining_balance_uc,
      earned_uc: balance?.earned_uc ?? 0,
    });
  } catch (err) {
    console.error("[credits/debit] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/credits/self-sustaining — check if authenticated agent is self-sustaining
creditRoutes.get("/credits/self-sustaining", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  try {
    const result = await checkSelfSustaining(c.env, agentId);
    return c.json(result);
  } catch (err) {
    console.error("[credits/self-sustaining] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/credits/pool — admin only, subsidy pool status
creditRoutes.get("/credits/pool", bearerAuth, async (c) => {
  if (c.get("agent_id") !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
  try {
    const pool = await getPoolStatus(c.env);
    if (!pool) {
      return c.json({ error: "Subsidy pool not initialized. POST /v1/credits/init-pool first." }, 404);
    }
    return c.json(pool);
  } catch (err) {
    console.error("[credits/pool] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/credits/init-pool — admin only, initialize or update subsidy pool
creditRoutes.post("/credits/init-pool", bearerAuth, async (c) => {
  if (c.get("agent_id") !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
  const { budget_uc, per_agent_cap_uc } = await c.req.json<{
    budget_uc: number;
    per_agent_cap_uc: number;
  }>();
  if (!budget_uc || budget_uc <= 0) {
    return c.json({ error: "budget_uc must be a positive number" }, 400);
  }
  if (!per_agent_cap_uc || per_agent_cap_uc <= 0) {
    return c.json({ error: "per_agent_cap_uc must be a positive number" }, 400);
  }
  try {
    const pool = await initSubsidyPool(c.env, budget_uc, per_agent_cap_uc);
    return c.json(pool, 201);
  } catch (err) {
    console.error("[credits/init-pool] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/credits/grant — admin only, grant credits to a specific agent
creditRoutes.post("/credits/grant", bearerAuth, async (c) => {
  if (c.get("agent_id") !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
  const { agent_id, amount_uc } = await c.req.json<{
    agent_id: string;
    amount_uc?: number;
  }>();
  if (!agent_id?.trim()) {
    return c.json({ error: "agent_id is required" }, 400);
  }
  try {
    const balance = await grantCredits(c.env, agent_id, amount_uc);
    if (!balance) {
      return c.json({
        error: "Grant failed — pool not initialized, exhausted, or agent already granted",
      }, 400);
    }
    return c.json(balance, 201);
  } catch (err) {
    console.error("[credits/grant] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// POST /v1/credits/sponsor-obligation — record + attempt immediate USDC payment
//
// SECURITY: this endpoint moves real USDC from the sponsor signer wallet to
// route creators, so it must NOT trust the client for the price or the
// recipient-of-record. Hard rules:
//
//  1. price_uc is capped at SPONSOR_MAX_PRICE_UC ($1) per call.
//  2. Total obligations per skill per UTC day are capped — repeated attempts
//     for the same skill within the same window are idempotent (no double pay).
//  3. transaction_id is required and used for dedupe so a network blip can't
//     re-trigger settlement.
//  4. Only authenticated agents may call this; admins have no bypass to the
//     caps so even a leaked admin key has bounded blast radius.
const SPONSOR_MAX_PRICE_UC = 1_000_000;        // $1.00 per call
const SPONSOR_MAX_DAILY_PRICE_UC = 100_000_000; // $100/day across the whole skill
creditRoutes.post("/credits/sponsor-obligation", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  const body = await c.req.json<{
    price_usd?: string;
    price_uc: number;
    skill_id: string;
    endpoint_id: string;
    timestamp: string;
    transaction_id: string;
  }>();

  if (!body.skill_id || typeof body.skill_id !== "string") {
    return c.json({ error: "skill_id is required" }, 400);
  }
  // SECURITY: transaction_id is required for idempotency. Earlier versions
  // accepted absence and fell back to a (timestamp, agent, skill, endpoint)
  // tuple, which lets a client retrying with a fresh timestamp double-pay
  // up to the daily cap. Force a stable id supplied by the caller.
  if (typeof body.transaction_id !== "string" || body.transaction_id.length === 0 || body.transaction_id.length > 128) {
    return c.json({
      error: "transaction_id is required and must be a non-empty string up to 128 chars",
    }, 400);
  }
  if (typeof body.price_uc !== "number" || !Number.isFinite(body.price_uc) || body.price_uc <= 0) {
    return c.json({ error: "price_uc must be a positive finite number" }, 400);
  }
  if (body.price_uc > SPONSOR_MAX_PRICE_UC) {
    return c.json({
      error: "price_uc exceeds per-call cap",
      cap_uc: SPONSOR_MAX_PRICE_UC,
    }, 400);
  }

  try {
    const kv = (c.env as Env).STATS_KV;

    // Look up the route creator's wallet from their agent profile
    const skillRaw = await kv.get(`skill:${body.skill_id}`) as string | null;
    const skill = skillRaw ? JSON.parse(skillRaw) as { indexer_id?: string; owner_agent_id?: string } : null;
    if (!skill) {
      return c.json({ error: "skill not found" }, 404);
    }
    let recipientWallet: string | null = null;
    if (skill.indexer_id) {
      const profileRaw = await kv.get(`agent:${skill.indexer_id}`) as string | null;
      const profile = profileRaw ? JSON.parse(profileRaw) as { wallet_address?: string } : null;
      recipientWallet = profile?.wallet_address ?? null;
    }

    // Record obligation. Existing obligations gate today's daily total.
    const listKey = "credits:sponsor-obligations";
    const existing = await kv.get(listKey) as string | null;
    const obligations = existing ? JSON.parse(existing) as any[] : [];

    // Idempotency: dedupe on transaction_id. The validation above forces a
    // stable client-supplied id, so retries with the same id never double-pay.
    const dedupeKey = body.transaction_id;
    const alreadySettled = obligations.find(
      (o) => (o.transaction_id === dedupeKey || o.dedupe_key === dedupeKey) && o.settled,
    );
    if (alreadySettled) {
      return c.json({
        recorded: true,
        settled: true,
        deduped: true,
        signature: alreadySettled.settlement_signature ?? null,
        total_pending: obligations.filter((o: any) => !o.settled).length,
      });
    }

    // Daily cap: sum settled+pending obligations for this skill today.
    const todayUtc = new Date().toISOString().slice(0, 10);
    const todaySpentUc = obligations
      .filter((o) => o.skill_id === body.skill_id && (o.created_at ?? "").startsWith(todayUtc))
      .reduce((sum, o) => sum + (typeof o.price_uc === "number" ? o.price_uc : 0), 0);
    if (todaySpentUc + body.price_uc > SPONSOR_MAX_DAILY_PRICE_UC) {
      return c.json({
        error: "daily sponsor cap exceeded",
        skill_id: body.skill_id,
        spent_uc_today: todaySpentUc,
        cap_uc: SPONSOR_MAX_DAILY_PRICE_UC,
      }, 429);
    }

    const obligation: any = {
      agent_id: agentId,
      ...body,
      dedupe_key: dedupeKey,
      created_at: new Date().toISOString(),
      indexer_id: skill?.indexer_id ?? null,
      recipient_wallet: recipientWallet,
      settled: false,
      settlement_signature: null,
    };

    // If we have a recipient wallet, try to pay immediately
    if (recipientWallet) {
      try {
        const { sendSponsorPayment } = await import("../services/sponsor-pay.js");
        const result = await sendSponsorPayment(c.env, recipientWallet, body.price_uc);
        if (result.success) {
          obligation.settled = true;
          obligation.settled_at = new Date().toISOString();
          obligation.settlement_signature = result.signature;
        } else {
          obligation.settlement_error = result.error;
        }
      } catch (err) {
        obligation.settlement_error = (err as Error).message;
      }
    }

    obligations.push(obligation);
    await kv.put(listKey, JSON.stringify(obligations));

    return c.json({
      recorded: true,
      settled: obligation.settled,
      signature: obligation.settlement_signature ?? null,
      total_pending: obligations.filter((o: any) => !o.settled).length,
    });
  } catch (err) {
    console.error("[credits/sponsor-obligation] error:", (err as Error).message);
    return c.json({ error: "sponsor obligation failed" }, 500);
  }
});

// GET /v1/credits/sponsor-obligations — admin only, list unsettled obligations
creditRoutes.get("/credits/sponsor-obligations", bearerAuth, async (c) => {
  if (c.get("agent_id") !== "__admin__") {
    return c.json({ error: "Admin only" }, 403);
  }
  try {
    const kv = (c.env as Env).STATS_KV;
    const raw = await kv.get("credits:sponsor-obligations") as string | null;
    const obligations = raw ? JSON.parse(raw) as any[] : [];
    const unsettled = obligations.filter((o) => !o.settled);
    const totalOwed = unsettled.reduce((sum: number, o: any) => sum + (o.price_uc || 0), 0);
    return c.json({
      total: obligations.length,
      unsettled: unsettled.length,
      total_owed_uc: totalOwed,
      total_owed_usd: (totalOwed / 1_000_000).toFixed(6),
      obligations: unsettled,
    });
  } catch (err) {
    console.error("[credits/sponsor-obligations] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});
