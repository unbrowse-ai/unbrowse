import { Hono } from "hono";
import type { Env } from "../types.js";
import { recordTransaction, getConsumerTransactions, getCreatorTransactions, getTransactionSummary } from "../services/transactions.js";
import { rateLimit } from "../middleware/rate-limit.js";

export const transactionRoutes = new Hono<{ Bindings: Env }>();

transactionRoutes.use("/transactions/*", rateLimit({ limit: 30, window: 60, prefix: "transactions" }));
// POST /v1/transactions -- record a new transaction
transactionRoutes.post("/transactions", async (c) => {
  try {
    const body = await c.req.json<{
      transaction_id: string;
      consumer_id: string;
      creator_id: string;
      skill_id: string;
      endpoint_id?: string;
      price_usd: number;
      payment_proof?: string;
    }>();

    if (!body.transaction_id || !body.consumer_id || !body.creator_id || !body.skill_id) {
      return c.json({ error: "Missing required fields: transaction_id, consumer_id, creator_id, skill_id" }, 400);
    }
    if (typeof body.price_usd !== "number" || body.price_usd < 0) {
      return c.json({ error: "price_usd must be a non-negative number" }, 400);
    }

    const tx = await recordTransaction(c.env, body);
    return c.json(tx, 201);
  } catch (err) {
    console.error("[transactions/record] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
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