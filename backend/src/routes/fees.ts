import { Hono } from "hono";
import type { Env } from "../types.js";
import { getFeesSummary, getAgentFeeLedger } from "../services/fees.js";
import { rateLimit } from "../middleware/rate-limit.js";

export const feeRoutes = new Hono<{ Bindings: Env }>();

feeRoutes.use("/fees/*", rateLimit({ limit: 30, window: 60, prefix: "fees" }));

// GET /v1/fees/summary — aggregate fee ledger summary across all agents
feeRoutes.get("/fees/summary", async (c) => {
  try {
    const summary = await getFeesSummary(c.env);
    return c.json(summary);
  } catch (err) {
    console.error("[fees/summary] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/fees/agent/:agentId — fee ledger for a specific agent
feeRoutes.get("/fees/agent/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  try {
    const ledger = await getAgentFeeLedger(c.env, agentId);
    if (!ledger) return c.json({ error: "No fees recorded for this agent" }, 404);
    return c.json(ledger);
  } catch (err) {
    console.error("[fees/agent] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});
