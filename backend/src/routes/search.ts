import { Hono } from "hono";
import type { Env } from "../types.js";
import { searchIntent, searchIntentInDomain, searchIntentResolve, shouldBypassSearchCache } from "../services/discovery.js";
import { rateLimit } from "../middleware/rate-limit.js";

export const searchRoutes = new Hono<{ Bindings: Env }>();

function searchOptions(c: { env: Env; req: { header(name: string): string | undefined } }) {
  return { skipCache: shouldBypassSearchCache(c.env, c.req.header("Authorization")) };
}

// Rate limit: 6 searches per 60 seconds per IP
searchRoutes.use("/search", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/domain", rateLimit({ limit: 30, window: 60, prefix: "search" }));
searchRoutes.use("/search/resolve", rateLimit({ limit: 30, window: 60, prefix: "search" }));

// POST /v1/search — global intent search
searchRoutes.post("/search", async (c) => {
  const { intent, k } = await c.req.json<{ intent: string; k?: number }>();
  if (!intent) return c.json({ error: "intent required" }, 400);
  try {
    const results = await searchIntent(c.env, intent, k ?? 5, searchOptions(c));
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
    const results = await searchIntentInDomain(c.env, intent, domain, k ?? 5, searchOptions(c));
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
    const results = await searchIntentResolve(c.env, intent, domain, domain_k ?? 5, global_k ?? 10, searchOptions(c));
    return c.json(results);
  } catch (err) {
    console.error("[search] resolve search failed:", (err as Error).message);
    return c.json({ domain_results: [], global_results: [], skipped_global: false });
  }
});
