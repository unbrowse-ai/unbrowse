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
creditRoutes.post("/credits/sponsor-obligation", bearerAuth, async (c) => {
  const agentId = c.get("agent_id");
  const body = await c.req.json<{
    price_usd: string;
    price_uc: number;
    skill_id: string;
    endpoint_id: string;
    timestamp: string;
  }>();
  try {
    const kv = (c.env as Env).STATS_KV;

    // Look up the route creator's wallet from their agent profile
    const skillRaw = await kv.get(`skill:${body.skill_id}`) as string | null;
    const skill = skillRaw ? JSON.parse(skillRaw) as { indexer_id?: string } : null;
    let recipientWallet: string | null = null;
    if (skill?.indexer_id) {
      const profileRaw = await kv.get(`agent:${skill.indexer_id}`) as string | null;
      const profile = profileRaw ? JSON.parse(profileRaw) as { wallet_address?: string } : null;
      recipientWallet = profile?.wallet_address ?? null;
    }

    // Record obligation
    const listKey = "credits:sponsor-obligations";
    const existing = await kv.get(listKey) as string | null;
    const obligations = existing ? JSON.parse(existing) as any[] : [];
    const obligation: any = {
      agent_id: agentId,
      ...body,
      indexer_id: skill?.indexer_id ?? null,
      recipient_wallet: recipientWallet,
      settled: false,
      settlement_signature: null,
    };

    // If we have a recipient wallet, try to pay immediately
    if (recipientWallet && body.price_uc > 0) {
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
    return c.json({ error: (err as Error).message }, 500);
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
