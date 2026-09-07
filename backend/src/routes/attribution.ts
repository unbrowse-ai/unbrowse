import { Hono } from "hono";
import type { Env } from "../types.js";
import { getIndexerLedger, getAttributionSummary } from "../services/attribution.js";
import { rateLimit } from "../middleware/rate-limit.js";

export const attributionRoutes = new Hono<{ Bindings: Env }>();

attributionRoutes.use("/attribution/*", rateLimit({ limit: 30, window: 60, prefix: "attribution" }));

// GET /v1/attribution/indexer/:indexerId -- indexer earnings from delta-based attribution
attributionRoutes.get("/attribution/indexer/:indexerId", async (c) => {
  const indexerId = c.req.param("indexerId");
  try {
    const ledger = await getIndexerLedger(c.env, indexerId);
    if (!ledger) return c.json({ error: "No attribution data for this indexer" }, 404);
    return c.json(ledger);
  } catch (err) {
    console.error("[attribution/indexer] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/attribution/summary -- aggregate attribution stats
attributionRoutes.get("/attribution/summary", async (c) => {
  try {
    const summary = await getAttributionSummary(c.env);
    return c.json(summary);
  } catch (err) {
    console.error("[attribution/summary] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});