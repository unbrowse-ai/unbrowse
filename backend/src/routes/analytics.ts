import { Hono } from "hono";
import type { Env } from "../types.js";
import {
  getActivation,
  getAgentHealth,
  getBottleneckMetrics,
  getEngagement,
  getRetention,
} from "../services/analytics.js";
import { getAcquisitionSummary } from "../services/acquisition.js";
import { getFunnelSummary } from "../services/funnel.js";
import { getInstallTelemetrySummary } from "../services/install-telemetry.js";
import { getLandingHomepageAnalyticsSummary } from "../services/landing-experiments.js";
import {
  getGrowthMetrics,
  getNetworkHealthMetrics,
  getOptimizationFunnel,
  getRevenuePricing,
  getUnitEconomicsMetrics,
  getUsageMetrics,
  recordAdoptionSnapshot,
  recordSessionSummary,
  saveRevenuePricing,
} from "../services/metrics.js";
import { bearerAuth } from "../middleware/auth.js";

export const analyticsRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// All analytics routes require auth; scope it to the analytics prefix only.
analyticsRoutes.use("/analytics/*", bearerAuth);

function setAnalyticsHeaders(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Authorization");
}

analyticsRoutes.get("/analytics/engagement", async (c) => {
  const metrics = await getEngagement(c.env);
  setAnalyticsHeaders(c);
  return c.json(metrics);
});

analyticsRoutes.get("/analytics/retention", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 60);
  const cohorts = await getRetention(c.env, days);
  setAnalyticsHeaders(c);
  return c.json({ cohorts });
});

analyticsRoutes.get("/analytics/activation", async (c) => {
  const funnel = await getActivation(c.env);
  setAnalyticsHeaders(c);
  return c.json(funnel);
});

analyticsRoutes.get("/analytics/growth", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 90);
  const growth = await getGrowthMetrics(c.env, days);
  setAnalyticsHeaders(c);
  return c.json(growth);
});

analyticsRoutes.get("/analytics/usage", async (c) => {
  const usage = await getUsageMetrics(c.env);
  setAnalyticsHeaders(c);
  return c.json(usage);
});

analyticsRoutes.get("/analytics/funnel", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 90);
  const funnel = await getOptimizationFunnel(c.env, days);
  setAnalyticsHeaders(c);
  return c.json(funnel);
});

analyticsRoutes.get("/analytics/network", async (c) => {
  const metrics = await getNetworkHealthMetrics(c.env);
  setAnalyticsHeaders(c);
  return c.json(metrics);
});

analyticsRoutes.get("/analytics/economics", async (c) => {
  const metrics = await getUnitEconomicsMetrics(c.env);
  setAnalyticsHeaders(c);
  return c.json(metrics);
});

analyticsRoutes.get("/analytics/agents", async (c) => {
  const health = await getAgentHealth(c.env);
  setAnalyticsHeaders(c);
  return c.json(health);
});

analyticsRoutes.get("/analytics/bottleneck", async (c) => {
  const metrics = await getBottleneckMetrics(c.env);
  setAnalyticsHeaders(c);
  return c.json(metrics);
});

analyticsRoutes.get("/analytics/pricing", async (c) => {
  const pricing = await getRevenuePricing(c.env);
  setAnalyticsHeaders(c);
  return c.json(pricing);
});

analyticsRoutes.post("/analytics/pricing", async (c) => {
  if (c.get("agent_id") !== "__admin__") return c.json({ error: "Admin only" }, 403);
  const pricing = await saveRevenuePricing(c.env, await c.req.json());
  return c.json(pricing);
});

analyticsRoutes.post("/analytics/sessions", async (c) => {
  const body = await c.req.json<{
    session_id: string;
    started_at: string;
    completed_at?: string;
    trace_version?: string;
    api_calls?: number;
    discovery_queries?: number;
    cached_skill_calls?: number;
    fresh_index_calls?: number;
    browser_mode?: "default" | "replaced" | "manual" | "unknown";
  }>();
  if (!body.session_id || !body.started_at) {
    return c.json({ error: "session_id and started_at required" }, 400);
  }
  await recordSessionSummary(c.env, c.get("agent_id"), {
    session_id: body.session_id,
    started_at: body.started_at,
    completed_at: body.completed_at,
    trace_version: body.trace_version,
    api_calls: body.api_calls ?? 0,
    discovery_queries: body.discovery_queries,
    cached_skill_calls: body.cached_skill_calls,
    fresh_index_calls: body.fresh_index_calls,
    browser_mode: body.browser_mode,
  });
  return c.json({ ok: true });
});

analyticsRoutes.post("/analytics/adoption", async (c) => {
  if (c.get("agent_id") !== "__admin__") return c.json({ error: "Admin only" }, 403);
  const body = await c.req.json<{
    metric: "npm_installs" | "github_stars" | "cli_installs";
    value: number;
    captured_at?: string;
  }>();
  if (!body.metric || typeof body.value !== "number") {
    return c.json({ error: "metric and numeric value required" }, 400);
  }
  await recordAdoptionSnapshot(c.env, {
    metric: body.metric,
    value: body.value,
    captured_at: body.captured_at ?? new Date().toISOString(),
  });
  return c.json({ ok: true });
});

analyticsRoutes.get("/analytics/dashboard", async (c) => {
  const [growth, engagement, usage, funnel, activation, network, economics, pricing, agentHealth, bottleneck] = await Promise.all([
    getGrowthMetrics(c.env),
    getEngagement(c.env),
    getUsageMetrics(c.env),
    getOptimizationFunnel(c.env),
    getActivation(c.env),
    getNetworkHealthMetrics(c.env),
    getUnitEconomicsMetrics(c.env),
    getRevenuePricing(c.env),
    getAgentHealth(c.env),
    getBottleneckMetrics(c.env),
  ]);
  setAnalyticsHeaders(c);
  return c.json({
    growth,
    engagement,
    usage,
    funnel,
    activation,
    network,
    economics,
    pricing,
    agent_health: agentHealth,
    bottleneck,
  });
});

analyticsRoutes.get("/analytics/acquisition", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 90);
  const summary = await getAcquisitionSummary(c.env, days);
  setAnalyticsHeaders(c);
  return c.json(summary);
});

analyticsRoutes.get("/analytics/install", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "90", 10), 180);
  const summary = await getInstallTelemetrySummary(c.env, days);
  setAnalyticsHeaders(c);
  return c.json(summary);
});

analyticsRoutes.get("/analytics/install-funnel", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "90", 10), 180);
  const summary = await getFunnelSummary(c.env, days);
  setAnalyticsHeaders(c);
  return c.json(summary);
});

analyticsRoutes.get("/analytics/landing-funnel", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 180);
  const summary = await getLandingHomepageAnalyticsSummary(c.env, days);
  setAnalyticsHeaders(c);
  return c.json(summary);
});
