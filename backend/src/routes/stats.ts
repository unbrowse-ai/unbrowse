import { Hono } from "hono";
import type { Env, OrchestrationTiming } from "../types.js";
import { recordExecution, recordFeedback } from "../services/scoring.js";
import { recordPerf, getPerf } from "../services/perf.js";
import { validateSkillManifest } from "../services/validator.js";
import { incrementAgentExecutions, incrementAgentFeedback, countAgents } from "../services/agents.js";
import { rateLimit, agentRateLimit } from "../middleware/rate-limit.js";
import { skillsKV, statsKV } from "../services/kv.js";

// Public stats — no auth required
export const publicStatsRoutes = new Hono<{ Bindings: Env }>();

// GET /v1/stats/summary — aggregated counts for the landing page
publicStatsRoutes.get("/stats/summary", async (c) => {
  // Both lists served from index — 2 HTTP calls total instead of 150+
  const [skillEntries, statEntries] = await Promise.all([
    skillsKV(c.env).listWithValues("skill:"),
    statsKV(c.env).listWithValues("stats:"),
  ]);

  const skillCount = skillEntries.length;
  let endpointCount = 0;
  const domainSet = new Set<string>();
  for (const { value } of skillEntries) {
    try {
      const s = JSON.parse(value) as { endpoints?: unknown[]; domain?: string };
      endpointCount += s.endpoints?.length ?? 0;
      if (s.domain) domainSet.add(s.domain);
    } catch { /* skip malformed */ }
  }

  let totalExecutions = 0;
  for (const { value } of statEntries) {
    try {
      const s = JSON.parse(value) as { total_executions?: number };
      totalExecutions += s.total_executions ?? 0;
    } catch { /* skip malformed */ }
  }


  const agentCount = await countAgents(c.env);

  const perfStats = await getPerf(c.env);

  c.header("Cache-Control", "public, max-age=60");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({
    skills: skillCount,
    endpoints: endpointCount,
    domains: domainSet.size,
    executions: totalExecutions,
    agents: agentCount,
    perf: {
      total_resolves: perfStats.total_resolves,
      marketplace_hit_rate: perfStats.total_resolves > 0
        ? Math.round((perfStats.marketplace_hits + perfStats.cache_hits) / perfStats.total_resolves * 100)
        : 0,
      avg_resolve_ms: Math.round(perfStats.avg_total_ms),
      avg_marketplace_ms: Math.round(perfStats.avg_marketplace_ms),
      avg_cache_ms: Math.round(perfStats.avg_cache_ms),
      p95_ms: Math.round(perfStats.p95_total_ms),
      total_tokens_saved: perfStats.total_tokens_saved,
      avg_time_saved_pct: Math.round(perfStats.avg_time_saved_pct),
      avg_tokens_saved_pct: Math.round(perfStats.avg_tokens_saved_pct),
    },
  });
});

// GET /v1/stats/perf — aggregated orchestration performance
publicStatsRoutes.get("/stats/perf", async (c) => {
  const stats = await getPerf(c.env);
  c.header("Cache-Control", "public, max-age=10");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(stats);
});

// Public validation — no auth required, rate limited
export const publicValidateRoutes = new Hono<{ Bindings: Env }>();

publicValidateRoutes.use("/validate", rateLimit({ limit: 60, window: 60, prefix: "validate" }));

publicValidateRoutes.post("/validate", async (c) => {
  const body = await c.req.json();
  const result = validateSkillManifest(body);
  return c.json(result);
});

// Protected stats — require auth
export const statsRoutes = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();

// Rate limit: 120 executions per 60s, 60 feedback per 60s per agent
statsRoutes.use("/stats/execution", agentRateLimit({ limit: 120, window: 60, prefix: "execution" }));
statsRoutes.use("/stats/feedback", agentRateLimit({ limit: 60, window: 60, prefix: "feedback" }));

// POST /v1/stats/perf — record orchestration timing
statsRoutes.use("/stats/perf", agentRateLimit({ limit: 120, window: 60, prefix: "perf" }));
statsRoutes.post("/stats/perf", async (c) => {
  const timing = await c.req.json<OrchestrationTiming>();
  if (!timing || typeof timing.total_ms !== "number") {
    return c.json({ error: "invalid timing data" }, 400);
  }
  await recordPerf(c.env, timing);
  return c.json({ ok: true });
});

// POST /v1/stats/execution — record execution + recompute score
statsRoutes.post("/stats/execution", async (c) => {
  const { skill_id, endpoint_id, trace } = await c.req.json<{
    skill_id: string;
    endpoint_id: string;
    trace: import("../types.js").ExecutionTrace;
  }>();
  if (!skill_id || !endpoint_id || !trace) {
    return c.json({ error: "skill_id, endpoint_id, and trace required" }, 400);
  }
  await recordExecution(c.env, skill_id, endpoint_id, trace);
  // Track agent contribution (non-blocking)
  const agentId = c.get("agent_id");
  if (agentId) {
    c.executionCtx.waitUntil(incrementAgentExecutions(c.env, agentId));
  }
  return c.json({ ok: true });
});

// POST /v1/stats/feedback — record feedback + recompute score
statsRoutes.post("/stats/feedback", async (c) => {
  const { skill_id, endpoint_id, rating } = await c.req.json<{
    skill_id: string;
    endpoint_id: string;
    rating: number;
  }>();
  if (!skill_id || !endpoint_id || rating == null) {
    return c.json({ error: "skill_id, endpoint_id, and rating required" }, 400);
  }
  const avgRating = await recordFeedback(c.env, skill_id, endpoint_id, rating);
  // Track agent contribution (non-blocking)
  const agentId = c.get("agent_id");
  if (agentId) {
    c.executionCtx.waitUntil(incrementAgentFeedback(c.env, agentId));
  }
  return c.json({ ok: true, avg_rating: avgRating });
});

