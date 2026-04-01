import { Hono } from "hono";
import type { Env } from "../types.js";
import { getEngagement, getRetention, getActivation, getAgentHealth, getBottleneckMetrics } from "../services/analytics.js";
import { getAcquisitionSummary } from "../services/acquisition.js";
import { getInstallTelemetrySummary } from "../services/install-telemetry.js";
import { getFunnelSummary } from "../services/funnel.js";
import { bearerAuth } from "../middleware/auth.js";

export const analyticsRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// All analytics routes require authentication — use specific path prefix
// instead of "*" to avoid intercepting unrelated /v1/* routes.
analyticsRoutes.use("/analytics/*", bearerAuth);

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

// GET /v1/analytics/acquisition — landing-to-install conversion funnel
analyticsRoutes.get("/analytics/acquisition", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 90);
  const summary = await getAcquisitionSummary(c.env, days);
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(summary);
});

// GET /v1/analytics/install — install-to-CLI-invocation tracking
analyticsRoutes.get("/analytics/install", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "90", 10), 180);
  const summary = await getInstallTelemetrySummary(c.env, days);
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(summary);
});

// GET /v1/analytics/funnel — first-run funnel transitions and failures
analyticsRoutes.get("/analytics/funnel", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "90", 10), 180);
  const summary = await getFunnelSummary(c.env, days);
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(summary);
});

// GET /v1/analytics/bottleneck — p50/p95 latencies and hit rates for break-even planning
analyticsRoutes.get("/analytics/bottleneck", async (c) => {
  const metrics = await getBottleneckMetrics(c.env);
  c.header("Cache-Control", "public, max-age=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(metrics);
});
