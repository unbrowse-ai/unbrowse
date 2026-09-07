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
import { getChurnCurve, getFunnelSummary, type ChurnSegmentBy } from "../services/funnel.js";
import { getFlywheelPulse } from "../services/flywheel.js";
import { getInstallTelemetrySummary } from "../services/install-telemetry.js";
import { getLandingHomepageAnalyticsSummary } from "../services/landing-experiments.js";
import { getCampaignFeedbackSummary } from "../services/campaign-feedback.js";
import { loadSurfaceErrors, loadUsagePings } from "../services/issues.js";
import { getProductAnalyticsReport, normalizeProductReportDays } from "../services/product-report.js";
import { buildCacheHeaders, safeExecutionCtx, withCache } from "../services/kv-cache.js";
import { variantForInstall, bumpCohortStage } from "../services/attribution-link.js";
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
import { bearerAuth, optionalAuth } from "../middleware/auth.js";

export const analyticsRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// All analytics routes require auth; scope it to the analytics prefix only.
// The session WRITE path (POST /analytics/sessions) accepts anonymous via optionalAuth so
// unregistered CLI installs' usage actually LANDS on the /internal dashboard (a bearer-gated
// write 401'd them and the client fire-and-forget-swallowed it → /internal looked empty
// despite many installs). Every other /analytics/* surface (admin reads) stays bearer-gated.
analyticsRoutes.use("/analytics/*", async (c, next) => {
  if (
    (c.req.method === "POST" && c.req.path.endsWith("/analytics/sessions")) ||
    (c.req.method === "GET" && (
      c.req.path.endsWith("/analytics/report") ||
      c.req.path.endsWith("/analytics/internal")
    ))
  ) {
    return optionalAuth(c, next);
  }
  return bearerAuth(c, next);
});

function setAnalyticsHeaders(c: { header(name: string, value: string): void }): void {
  c.header("Cache-Control", "private, no-store");
  c.header("Vary", "Authorization");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+([^\s]+)$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

function hasInternalReadAccess(
  agentId: string | undefined,
  authorization: string | undefined,
  dashboardPassword: string | undefined,
): boolean {
  if (agentId === "__admin__") return true;
  const token = bearerToken(authorization);
  return !!token && !!dashboardPassword && timingSafeEqual(token, dashboardPassword);
}

async function settleAnalyticsSource<T>(work: Promise<T>): Promise<{ available: true; data: T } | { available: false; data: null }> {
  try {
    return { available: true, data: await work };
  } catch {
    return { available: false, data: null };
  }
}

function allowlistedAggregateRows(
  rows: Array<{ key: string; count: number }>,
  allowlist: Set<string>,
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const normalized = row.key.trim().toLowerCase();
    const key = allowlist.has(normalized) ? normalized : "other";
    counts.set(key, (counts.get(key) ?? 0) + Math.max(0, row.count));
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

const INTERNAL_ERROR_KINDS = new Set([
  "captcha_block", "cli_timeout", "client_update_required", "econnrefused", "http_error", "no_route", "unknown",
]);
const INTERNAL_ERROR_SURFACES = new Set(["backend", "cli", "frontend", "local-http", "mcp", "sdk", "unknown"]);

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
    success?: boolean;
    source?: string;
    surface?: "cli" | "mcp" | "sdk" | "local-http" | "unknown";
    execution_scope?: "local" | "cloud" | "mixed" | "unknown";
    telemetry_schema_version?: number;
    time_saved_ms?: number;
    time_saved_pct?: number;
    tokens_saved?: number;
    tokens_saved_pct?: number;
    cost_saved_uc?: number;
    install_id?: string;
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
    success: body.success,
    source: body.source,
    surface: body.surface,
    execution_scope: body.execution_scope,
    telemetry_schema_version: body.telemetry_schema_version,
    time_saved_ms: body.time_saved_ms,
    time_saved_pct: body.time_saved_pct,
    tokens_saved: body.tokens_saved,
    tokens_saved_pct: body.tokens_saved_pct,
    cost_saved_uc: body.cost_saved_uc,
    install_id: body.install_id,
  });
  // Cohort funnel: count this install active once (best-effort, never blocks the session write).
  if (body.install_id) {
    try {
      const variant = (await variantForInstall(c.env, body.install_id)) || "(unattributed)";
      await bumpCohortStage(c.env, variant, "active", body.install_id);
    } catch {
      /* best-effort */
    }
  }
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

analyticsRoutes.get("/analytics/report", async (c) => {
  if (!hasInternalReadAccess(c.get("agent_id"), c.req.header("authorization"), c.env.INTERNAL_AUTH_PASSWORD)) {
    setAnalyticsHeaders(c);
    return c.json({ error: "Admin or dashboard token required" }, 403);
  }
  const requestedDays = normalizeProductReportDays(Number(c.req.query("days") ?? 30));
  const cacheResult = await withCache(
    c.env,
    `cache:analytics-report:v1:${requestedDays}`,
    60,
    {
      bypass: /(?:^|,)\s*no-cache(?:\s*(?:,|$))/i.test(c.req.header("cache-control") ?? ""),
      staleWhileRevalidate: true,
      ctx: safeExecutionCtx(c),
    },
    () => getProductAnalyticsReport(c.env, requestedDays),
  );
  setAnalyticsHeaders(c);
  for (const [name, value] of Object.entries(buildCacheHeaders(cacheResult))) c.header(name, value);
  return c.json(cacheResult.value);
});

/**
 * One private, fail-soft payload for the password-gated frontend signal room.
 * It deliberately returns aggregate categories only: no intents, URLs, tool
 * arguments, response bodies, credentials, or stable user-level rows.
 */
analyticsRoutes.get("/analytics/internal", async (c) => {
  if (!hasInternalReadAccess(c.get("agent_id"), c.req.header("authorization"), c.env.INTERNAL_AUTH_PASSWORD)) {
    setAnalyticsHeaders(c);
    return c.json({ error: "Admin or dashboard token required" }, 403);
  }

  const days = Math.max(7, Math.min(180, Math.trunc(Number(c.req.query("days") ?? 90) || 90)));
  // Warm the shared stats/skills indexes through the product report before
  // fanning out. Starting every list read at once creates a cold-isolate
  // subrequest stampede against the same two KV indexes.
  const productSource = await settleAnalyticsSource(getProductAnalyticsReport(c.env, days));
  const remainingSources = await Promise.all([
    settleAnalyticsSource(loadUsagePings(c.env, days)),
    settleAnalyticsSource(loadSurfaceErrors(c.env, days).then(({ total, by_kind, by_surface, by_version }) => ({
      total,
      by_kind: allowlistedAggregateRows(by_kind, INTERNAL_ERROR_KINDS),
      by_surface: allowlistedAggregateRows(by_surface, INTERNAL_ERROR_SURFACES),
      // Versions use the same semver-only contract as usage pings.
      by_version: allowlistedAggregateRows(
        by_version,
        new Set(by_version.map((row) => row.key).filter((key) => /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,48})?$/.test(key))),
      ),
    }))),
    settleAnalyticsSource(getInstallTelemetrySummary(c.env, days)),
    settleAnalyticsSource(getFunnelSummary(c.env, days)),
    settleAnalyticsSource(getChurnCurve(c.env, days, "install", undefined, "minor_version")),
    settleAnalyticsSource(getAcquisitionSummary(c.env, days)),
    settleAnalyticsSource(getLandingHomepageAnalyticsSummary(c.env, days)),
    settleAnalyticsSource(getGrowthMetrics(c.env, days)),
    settleAnalyticsSource(getNetworkHealthMetrics(c.env)),
    settleAnalyticsSource(getBottleneckMetrics(c.env)),
    settleAnalyticsSource(getUnitEconomicsMetrics(c.env)),
    settleAnalyticsSource(getActivation(c.env)),
    settleAnalyticsSource(getOptimizationFunnel(c.env, days)),
    settleAnalyticsSource(getRevenuePricing(c.env)),
    settleAnalyticsSource(getFlywheelPulse(c.env)),
    settleAnalyticsSource(getCampaignFeedbackSummary(c.env, { days })),
  ] as const);
  const sourceEntries = [productSource, ...remainingSources] as const;
  const names = [
    "product", "activity", "issues", "installs", "install_funnel", "install_churn", "acquisition",
    "landing_funnel", "growth", "network", "bottleneck", "economics", "activation", "optimization_funnel",
    "pricing", "flywheel", "attribution",
  ] as const;
  const sourceStatus = Object.fromEntries(names.map((name, index) => [name, { available: sourceEntries[index].available }]));

  setAnalyticsHeaders(c);
  return c.json({
    generated_at: new Date().toISOString(),
    window_days: days,
    privacy: {
      interpretation: "observed_minimum",
      detailed_intents_available: false,
      collected: "allowlisted operation, use-case, surface, scope, version, aggregate outcome counters",
      excluded: "raw intents, URLs, tool arguments, response bodies, credentials, and user-level activity rows",
    },
    sources: sourceStatus,
    product: sourceEntries[0].data,
    activity: sourceEntries[1].data,
    issues: sourceEntries[2].data,
    installs: sourceEntries[3].data,
    install_funnel: sourceEntries[4].data,
    install_churn: sourceEntries[5].data,
    acquisition: sourceEntries[6].data,
    landing_funnel: sourceEntries[7].data,
    growth: sourceEntries[8].data,
    network: sourceEntries[9].data,
    bottleneck: sourceEntries[10].data,
    economics: sourceEntries[11].data,
    activation: sourceEntries[12].data,
    optimization_funnel: sourceEntries[13].data,
    pricing: sourceEntries[14].data,
    flywheel: sourceEntries[15].data,
    attribution: sourceEntries[16].data,
  });
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

analyticsRoutes.get("/analytics/flywheel", async (c) => {
  const pulse = await getFlywheelPulse(c.env);
  setAnalyticsHeaders(c);
  return c.json(pulse);
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

analyticsRoutes.get("/analytics/churn-curve", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "90", 10), 180);
  const anchor = c.req.query("anchor") === "registration" ? "registration" as const : "install" as const;
  const offsetsParam = c.req.query("offsets");
  const offsets = offsetsParam
    ? offsetsParam.split(",").map(Number).filter(Number.isFinite)
    : undefined;
  const validSegments = new Set(["version", "minor_version", "platform", "cohort_week"]);
  const segmentParam = c.req.query("segment");
  const segmentBy = segmentParam && validSegments.has(segmentParam)
    ? segmentParam as ChurnSegmentBy
    : undefined;
  const summary = await getChurnCurve(c.env, days, anchor, offsets, segmentBy);
  setAnalyticsHeaders(c);
  return c.json(summary);
});

analyticsRoutes.get("/analytics/landing-funnel", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 180);
  const summary = await getLandingHomepageAnalyticsSummary(c.env, days);
  setAnalyticsHeaders(c);
  return c.json(summary);
});

analyticsRoutes.get("/analytics/attribution", async (c) => {
  const days = Math.min(parseInt(c.req.query("days") ?? "30", 10), 365);
  const filters: Record<string, string> = {};
  for (const key of ["channel", "campaign_id", "content_id", "inferred_icp", "variant_id", "experiment_id"] as const) {
    const value = c.req.query(key);
    if (value) filters[key] = value;
  }
  const summary = await getCampaignFeedbackSummary(c.env, {
    days,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
  });
  setAnalyticsHeaders(c);
  return c.json(summary);
});
