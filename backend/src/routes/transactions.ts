import { Hono } from "hono";
import type { Env } from "../types.js";
import { recordTransaction, getConsumerTransactions, getCreatorTransactions, getTransactionSummary } from "../services/transactions.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { bearerAuth, requireSignedClient } from "../middleware/auth.js";

export const transactionRoutes = new Hono<{ Bindings: Env }>();

transactionRoutes.use("/transactions/*", rateLimit({ limit: 30, window: 60, prefix: "transactions" }));
// POST /v1/transactions -- record a new transaction.
//
// SECURITY: this endpoint MUST NOT let a caller record arbitrary entries
// for other agents — earlier versions did, which polluted the leaderboard
// and let attackers attribute spending to victims. We force consumer_id =
// the authenticated agent_id, and we cap price_usd. Admins keep the
// ability to back-fill (e.g. to import from x402 facilitator logs).
const MAX_TRANSACTION_PRICE_USD = 100;
transactionRoutes.post("/transactions", bearerAuth, requireSignedClient, async (c) => {
  try {
    const body = await c.req.json<{
      transaction_id: string;
      consumer_id?: string;
      creator_id?: string;
      skill_id: string;
      endpoint_id?: string;
      price_usd: number;
      payment_proof?: string;
    }>();

    const callerAgentId = c.get("agent_id") as string | undefined;
    const isAdmin = callerAgentId === "__admin__";

    if (!body.transaction_id || !body.skill_id) {
      return c.json({ error: "Missing required fields: transaction_id, skill_id" }, 400);
    }
    if (typeof body.transaction_id !== "string" || body.transaction_id.length > 128) {
      return c.json({ error: "transaction_id must be a string up to 128 chars" }, 400);
    }
    if (typeof body.price_usd !== "number" || !Number.isFinite(body.price_usd) || body.price_usd < 0) {
      return c.json({ error: "price_usd must be a non-negative finite number" }, 400);
    }
    if (body.price_usd > MAX_TRANSACTION_PRICE_USD) {
      return c.json({ error: `price_usd must be <= ${MAX_TRANSACTION_PRICE_USD}` }, 400);
    }

    // Force consumer_id = caller unless admin. Strip creator_id from
    // non-admin callers so they can't impute earnings to a victim.
    const safeConsumerId = isAdmin
      ? (body.consumer_id ?? callerAgentId ?? "anonymous")
      : (callerAgentId ?? "anonymous");
    const safeCreatorId = isAdmin ? body.creator_id : undefined;

    const tx = await recordTransaction(c.env, {
      transaction_id: body.transaction_id,
      consumer_id: safeConsumerId,
      creator_id: safeCreatorId,
      skill_id: body.skill_id,
      endpoint_id: body.endpoint_id,
      price_usd: body.price_usd,
      payment_proof: body.payment_proof,
    });
    return c.json(tx, 201);
  } catch (err) {
    console.error("[transactions/record] error:", (err as Error).message);
    return c.json({ error: "Failed to record transaction" }, 500);
  }
});
// GET /v1/transactions/consumer/:agentId -- consumer payment history
transactionRoutes.get("/transactions/consumer/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  try {
    const result = await getConsumerTransactions(c.env, agentId);
    if (!result.ledger) return c.json({ error: "No transactions found for this consumer" }, 404);
    return c.json(result);
  } catch (err) {
    console.error("[transactions/consumer] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/transactions/creator/:agentId -- creator earnings history
transactionRoutes.get("/transactions/creator/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  try {
    const result = await getCreatorTransactions(c.env, agentId);
    if (!result.ledger) return c.json({ error: "No transactions found for this creator" }, 404);
    return c.json(result);
  } catch (err) {
    console.error("[transactions/creator] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/transactions/summary -- aggregate transaction stats
transactionRoutes.get("/transactions/summary", async (c) => {
  try {
    const summary = await getTransactionSummary(c.env);
    return c.json(summary);
  } catch (err) {
    console.error("[transactions/summary] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});
