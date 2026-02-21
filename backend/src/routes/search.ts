import { Hono } from "hono";
import type { Env } from "../types.js";
import { searchIntent, searchIntentInDomain } from "../services/discovery.js";

export const searchRoutes = new Hono<{ Bindings: Env }>();

// POST /v1/search — global intent search
searchRoutes.post("/search", async (c) => {
  const { intent, k } = await c.req.json<{ intent: string; k?: number }>();
  if (!intent) return c.json({ error: "intent required" }, 400);
  const results = await searchIntent(c.env, intent, k ?? 5);
  return c.json({ results });
});

// POST /v1/search/domain — domain-scoped intent search
searchRoutes.post("/search/domain", async (c) => {
  const { intent, domain, k } = await c.req.json<{ intent: string; domain: string; k?: number }>();
  if (!intent || !domain) return c.json({ error: "intent and domain required" }, 400);
  const results = await searchIntentInDomain(c.env, intent, domain, k ?? 5);
  return c.json({ results });
});
