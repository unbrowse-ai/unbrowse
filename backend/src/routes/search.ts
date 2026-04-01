import { Hono } from "hono";
import type { Env } from "../types.js";
import { searchIntent, searchIntentInDomain, searchIntentResolve } from "../services/discovery.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { recordGraphFee } from "../services/fees.js";

/** Extract agent_id from Authorization header (Bearer token) if present. */
function extractAgentId(authHeader: string | undefined | null): string {
  if (!authHeader) return "anonymous";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  return token || "anonymous";
}

/** Record a search fee in the background — never blocks or fails the response. */
function chargeSearchFee(env: Env, agentId: string): void {
  recordGraphFee(env, agentId, "search").catch(() => { /* fee recording must not break the API */ });
}

export const searchRoutes = new Hono<{ Bindings: Env }>();

// Rate limit: 6 searches per 60 seconds per IP
searchRoutes.use("/search", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/domain", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/resolve", rateLimit({ limit: 30, window: 60, prefix: "search" }));

// POST /v1/search — global intent search
searchRoutes.post("/search", async (c) => {
  const { intent, k } = await c.req.json<{ intent: string; k?: number }>();
  if (!intent) return c.json({ error: "intent required" }, 400);
  try {
    const agentId = extractAgentId(c.req.header("Authorization"));
    const results = await searchIntent(c.env, intent, k ?? 5);
    chargeSearchFee(c.env, agentId);
    return c.json({ results });
  } catch (err) {
    console.error("[search] global search failed:", (err as Error).message);
    return c.json({ results: [] });
  }
});

// POST /v1/search/domain — domain-scoped intent search
searchRoutes.post("/search/domain", async (c) => {
  const { intent, domain, k } = await c.req.json<{ intent: string; domain: string; k?: number }>();
  if (!intent || !domain) return c.json({ error: "intent and domain required" }, 400);
  try {
    const agentId = extractAgentId(c.req.header("Authorization"));
    const results = await searchIntentInDomain(c.env, intent, domain, k ?? 5);
    chargeSearchFee(c.env, agentId);
    return c.json({ results });
  } catch (err) {
    console.error("[search] domain search failed:", (err as Error).message);
    return c.json({ results: [] });
  }
});

// POST /v1/search/resolve — shared-embed resolve search with optional domain bias
searchRoutes.post("/search/resolve", async (c) => {
  const { intent, domain, domain_k, global_k } = await c.req.json<{
    intent: string;
    domain?: string;
    domain_k?: number;
    global_k?: number;
  }>();
  if (!intent) return c.json({ error: "intent required" }, 400);
  try {
    const agentId = extractAgentId(c.req.header("Authorization"));
    const results = await searchIntentResolve(c.env, intent, domain, domain_k ?? 5, global_k ?? 10);
    chargeSearchFee(c.env, agentId);
    return c.json(results);
  } catch (err) {
    console.error("[search] resolve search failed:", (err as Error).message);
    return c.json({ domain_results: [], global_results: [], skipped_global: false });
  }
});
