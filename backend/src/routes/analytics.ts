import { Hono } from "hono";
import type { Env } from "../types.js";
import { getEngagement, getRetention, getActivation, getAgentHealth } from "../services/analytics.js";

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

// GET /v1/analytics/engagement — DAU/WAU/MAU and stickiness ratios
analyticsRoutes.get("/analytics/engagement", async (c) => {
  const metrics = await getEngagement(c.env);
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(metrics);
});

// GET /v1/analytics/retention — cohort retention (d1, d3, d7, d14, d30)
analyticsRoutes.get("/analytics/retention", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 60);
  const cohorts = await getRetention(c.env, days);
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ cohorts });
});

// GET /v1/analytics/activation — registration-to-power-user funnel
analyticsRoutes.get("/analytics/activation", async (c) => {
  const funnel = await getActivation(c.env);
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(funnel);
});

// GET /v1/analytics/agents — agent health overview with top users
analyticsRoutes.get("/analytics/agents", async (c) => {
  const health = await getAgentHealth(c.env);
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(health);
});

// GET /v1/analytics/dashboard — combined view of all metrics
analyticsRoutes.get("/analytics/dashboard", async (c) => {
  const [engagement, activation, agentHealth] = await Promise.all([
    getEngagement(c.env),
    getActivation(c.env),
    getAgentHealth(c.env),
  ]);
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({ engagement, activation, agent_health: agentHealth });
});
