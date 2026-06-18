import { Hono } from "hono";
import type { Env, OrchestrationTiming } from "../types.js";
import { bearerAuth, optionalAuth } from "../middleware/auth.js";
import { recordExecution, recordFeedback, recordReflectionOutcome, getServerReliability } from "../services/scoring.js";
import { recordPerf, getPerf, recordAgentPerf } from "../services/perf.js";
import { invalidateDashboardCaches } from "../services/economics.js";
import { validateSkillManifest } from "../services/validator.js";
import { recordAgentExecution, recordAgentFeedback, countAgents } from "../services/agents.js";
import { rateLimit, agentRateLimit } from "../middleware/rate-limit.js";
import { skillsKV, statsKV } from "../services/kv.js";
import { getAgentFeeLedger, getFeesSummary } from "../services/fees.js";
import { recordAttribution, getIndexerLedger, getAttributionSummary } from "../services/attribution.js";
import { getSkill } from "../services/marketplace.js";
import { updateContributorDelta } from "../services/splits.js";
import { getOrSetHttpCache } from "../services/http-cache.js";
import { getTractionMetrics } from "../services/traction.js";
import { statsKVOr503 } from "../services/stats-kv-guard.js";
import {
  getEngagement,
  getRetention,
  getActivation,
  getAgentHealth,
  getBottleneckMetrics,
} from "../services/analytics.js";
import {
  getGrowthMetrics,
  getUsageMetrics,
  getOptimizationFunnel,
  getNetworkHealthMetrics,
  getUnitEconomicsMetrics,
} from "../services/metrics.js";
// Public stats — no auth required
export const publicStatsRoutes = new Hono<{ Bindings: Env }>();

// GET /v1/stats/summary — aggregated counts for the landing page
publicStatsRoutes.get("/stats/summary", async (c) => {
  const payload = await getOrSetHttpCache(c.env, "stats:summary", 60, async () => {
    const [skillEntries, statEntries] = await Promise.all([
      skillsKV(c.env).listWithValues("skill:"),
      statsKV(c.env).listWithValues("stats:"),
    ]);

    let skillCount = 0;
    let endpointCount = 0;
    const domainSet = new Set<string>();
    for (const { value } of skillEntries) {
      try {
        const s = JSON.parse(value) as { endpoints?: unknown[]; domain?: string; lifecycle?: string };
        if (s.lifecycle === "deprecated" || s.lifecycle === "disabled") continue;
        skillCount++;
        endpointCount += s.endpoints?.length ?? 0;
        if (s.domain) domainSet.add(s.domain);
      } catch {}
    }

    let totalExecutions = 0;
    for (const { value } of statEntries) {
      try {
        const s = JSON.parse(value) as { total_executions?: number };
        totalExecutions += s.total_executions ?? 0;
      } catch {}
    }

    const agentCount = await countAgents(c.env);
    const perfStats = await getPerf(c.env);

    return {
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
    };
  });

  c.header("Cache-Control", "public, max-age=60, s-maxage=60, stale-while-revalidate=300");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(payload);
});
// GET /v1/stats/traction — growth and usage metrics for external tools
publicStatsRoutes.get("/stats/traction", async (c) => {
  const payload = await getOrSetHttpCache(c.env, "stats:traction", 300, async () => {
    return await getTractionMetrics(c.env);
  });
  
  c.header("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=600");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(payload);
});

// GET /v1/stats/deep: full analytics surface (cohorts, retention, funnel, bottlenecks).
publicStatsRoutes.get("/stats/deep", async (c) => {
  const payload = await getOrSetHttpCache(c.env, "stats:deep", 300, async () => {
    const [
      engagement,
      retention,
      activation,
      optimization_funnel,
      agent_health,
      growth,
      usage,
      bottlenecks,
      network_health,
      unit_economics,
    ] = await Promise.all([
      getEngagement(c.env),
      getRetention(c.env),
      getActivation(c.env),
      getOptimizationFunnel(c.env),
      getAgentHealth(c.env),
      getGrowthMetrics(c.env),
      getUsageMetrics(c.env),
      getBottleneckMetrics(c.env),
      getNetworkHealthMetrics(c.env),
      getUnitEconomicsMetrics(c.env),
    ]);
    return {
      engagement,
      retention,
      activation,
      optimization_funnel,
      agent_health,
      growth,
      usage,
      bottlenecks,
      network_health,
      unit_economics,
    };
  });

  c.header("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=600");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(payload);
});

// GET /v1/stats/coverage — public compatibility matrix for domains/endpoints
publicStatsRoutes.get("/stats/coverage", async (c) => {
  const payload = await getOrSetHttpCache(c.env, "stats:coverage", 120, async () => {
    const [skillEntries, statEntries] = await Promise.all([
      skillsKV(c.env).listWithValues("skill:"),
      statsKV(c.env).listWithValues("stats:"),
    ]);

    // Build stats lookup
    const statsMap = new Map<string, unknown>();
    for (const { key, value } of statEntries) {
      try { statsMap.set(key, JSON.parse(value)); } catch {}
    }

    const domains: Array<{
      domain: string;
      skill_id: string;
      endpoints: Array<{
        endpoint_id: string;
        method: string;
        url_template: string;
        verification_status: string;
        reliability_score: number;
        total_executions: number;
        successful_executions: number;
        version_history: Array<{ version: string; status: string; verified_at: string }>;
      }>;
    }> = [];

    for (const { value } of skillEntries) {
      try {
        const skill = JSON.parse(value) as {
          skill_id: string; domain: string; lifecycle?: string;
          endpoints?: Array<{ endpoint_id: string; method: string; url_template: string; verification_status?: string; reliability_score?: number }>;
        };
        if (skill.lifecycle === "deprecated" || skill.lifecycle === "disabled") continue;
        if (!skill.endpoints?.length) continue;

        const eps = skill.endpoints.map((ep) => {
          const stats = statsMap.get(`stats:${skill.skill_id}:${ep.endpoint_id}`) as {
            total_executions?: number; successful_executions?: number; version_history?: Array<{ version: string; status: string; verified_at: string }>;
          } | undefined;
          return {
            endpoint_id: ep.endpoint_id,
            method: ep.method,
            url_template: ep.url_template,
            verification_status: ep.verification_status ?? "unverified",
            reliability_score: ep.reliability_score ?? 0,
            total_executions: stats?.total_executions ?? 0,
            successful_executions: stats?.successful_executions ?? 0,
            version_history: stats?.version_history ?? [],
          };
        });

        domains.push({ domain: skill.domain, skill_id: skill.skill_id, endpoints: eps });
      } catch {}
    }

    // Sort by most endpoints first
    domains.sort((a, b) => b.endpoints.length - a.endpoints.length);

    const totalVerified = domains.reduce((n, d) => n + d.endpoints.filter((e) => e.verification_status === "verified").length, 0);
    const totalEndpoints = domains.reduce((n, d) => n + d.endpoints.length, 0);

    return {
      domains: domains.length,
      total_endpoints: totalEndpoints,
      verified_endpoints: totalVerified,
      coverage_pct: totalEndpoints > 0 ? Math.round((totalVerified / totalEndpoints) * 100) : 0,
      data: domains,
    };
  });

  c.header("Cache-Control", "public, max-age=120, s-maxage=120, stale-while-revalidate=600");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json(payload);
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
statsRoutes.use("/stats/reflect", agentRateLimit({ limit: 60, window: 60, prefix: "reflect" }));

// POST /v1/stats/perf — record orchestration timing
statsRoutes.use("/stats/perf", agentRateLimit({ limit: 120, window: 60, prefix: "perf" }));
statsRoutes.post("/stats/perf", optionalAuth, async (c) => {
  const timing = await c.req.json<OrchestrationTiming>();
  if (!timing || typeof timing.total_ms !== "number") {
    return c.json({ error: "invalid timing data" }, 400);
  }
  const integerFields = [
    "baseline_total_ms",
    "actual_total_ms",
    "time_saved_ms",
    "baseline_cost_uc",
    "actual_cost_uc",
    "cost_saved_uc",
    "paid_search_uc",
    "paid_execution_uc",
  ] as const;
  for (const field of integerFields) {
    const value = timing[field];
    if (value != null && (!Number.isInteger(value) || value < 0)) {
      return c.json({ error: `${field} must be a non-negative integer` }, 400);
    }
  }
  await recordPerf(c.env, timing);
  const agentId = c.get("agent_id");
  if (agentId && agentId !== "__admin__") {
    await recordAgentPerf(c.env, agentId, timing);
  }
  return c.json({ ok: true });
});

// POST /v1/stats/diagnostics — agent-reported speed/accuracy diagnostics
statsRoutes.use("/stats/diagnostics", agentRateLimit({ limit: 120, window: 60, prefix: "diagnostics" }));
statsRoutes.post("/stats/diagnostics", optionalAuth, async (c) => {
  const body = await c.req.json<{
    skill_id: string;
    endpoint_id: string;
    total_ms?: number;
    bottleneck?: string;
    wrong_endpoint?: boolean;
    expected_data?: string;
    got_data?: string;
    trace_version?: string;
  }>();
  if (!body.skill_id || !body.endpoint_id) {
    return c.json({ error: "skill_id and endpoint_id required" }, 400);
  }
  // Store in KV for analysis — keyed by trace_version for version grouping
  const key = `diag:${body.trace_version ?? "unknown"}:${Date.now()}`;
  // A5 silent-500 guard: surface a typed 503 envelope if STATS_KV is not
  // provisioned, instead of crashing in `c.env.STATS_KV.put(...)` below.
  const kvOrRes = statsKVOr503(c, { key });
  if (kvOrRes instanceof Response) return kvOrRes;
  await kvOrRes.put(key, JSON.stringify({
    ...body,
    agent_id: c.get("agent_id"),
    ts: new Date().toISOString(),
  }), { expirationTtl: 90 * 86400 }); // 90 day retention
  return c.json({ ok: true });
});

// POST /v1/stats/execution — record execution + recompute score + Tier 1 attribution
statsRoutes.post("/stats/execution", bearerAuth, async (c) => {
  const body = await c.req.json<{
    skill_id: string;
    endpoint_id: string;
    trace: import("../types.js").ExecutionTrace;
    /** Optional: indexer who published the skill (for Tier 1 attribution). */
    indexer_id?: string;
    /** Optional: reliability score of the next best alternative endpoint. */
    next_best_score?: number;
  }>();
  const { skill_id, endpoint_id, trace } = body;
  if (!skill_id || !endpoint_id || !trace) {
    return c.json({ error: "skill_id, endpoint_id, and trace required" }, 400);
  }
  await recordExecution(c.env, skill_id, endpoint_id, trace, c.get("agent_id"));
  // Track agent contribution + activity in one queued profile write.
  const agentId = c.get("agent_id");
  if (agentId) {
    c.executionCtx.waitUntil(recordAgentExecution(c.env, agentId));
    // A new execution changes this agent's savings + the leaderboard — bust the
    // cloud cache so the dashboard reflects it immediately (stale-on-change).
    c.executionCtx.waitUntil(invalidateDashboardCaches(c.env, agentId));
  }
  // Tier 1 attribution: credit the indexer if execution succeeded.
  // SECURITY: the indexer to credit is ALWAYS derived from the STORED skill (the
  // authoritative record of who indexed it, set at publish by the authenticated
  // publisher), NEVER from the client `body.indexer_id` — trusting the body let any
  // caller credit earnings to an arbitrary (victim or self) agent_id. The execution
  // reporter (a consumer) is not the indexer, so we cannot use the authed agent here;
  // the skill itself is the source of truth.
  if (trace.success) {
    const storedSkill = await getSkill(c.env, skill_id);
    const indexerId = storedSkill?.indexer_id;
    if (indexerId) {
      const { getStats } = await import("../services/scoring.js");
      const stats = await getStats(c.env, skill_id, endpoint_id);
      c.executionCtx.waitUntil(
        recordAttribution(c.env, {
          execution_id: trace.trace_id,
          skill_id,
          endpoint_id,
          indexer_id: indexerId,
          reliability_score: stats.total_executions > 0
            ? stats.successful_executions / stats.total_executions
            : 0.5,
          next_best_score: body.next_best_score ?? 0,
        }).then((event) => {
          // Update contributor delta scores for split share recomputation
          return updateContributorDelta(c.env, skill_id, indexerId!, event.delta_score);
        }),
      );
    }
  } else if ((c.env as { ATTRIBUTION_SLASHING?: string }).ATTRIBUTION_SLASHING === "1") {
    // Opt-in slashing: a FAILED execution where a viable alternative existed
    // reduces the publisher's standing (mirror of the success-path credit).
    // Default-off — live payout economics are unchanged unless ATTRIBUTION_SLASHING=1.
    // Same security rule as the success path: derive the indexer from the STORED skill,
    // never from the forgeable client body.
    const storedSkill = await getSkill(c.env, skill_id);
    const indexerId = storedSkill?.indexer_id;
    if (indexerId) {
      const { recordFailureAttribution } = await import("../services/attribution.js");
      c.executionCtx.waitUntil(
        recordFailureAttribution(c.env, {
          execution_id: trace.trace_id,
          skill_id,
          endpoint_id,
          indexer_id: indexerId,
          next_best_score: body.next_best_score ?? 0,
        }).then((res) =>
          res.slash_delta !== 0
            ? updateContributorDelta(c.env, skill_id, indexerId!, res.slash_delta)
            : undefined,
        ),
      );
    }
  }
  return c.json({ ok: true });
});

// POST /v1/stats/feedback — record feedback + recompute score
statsRoutes.post("/stats/feedback", optionalAuth, async (c) => {
  const { skill_id, endpoint_id, rating } = await c.req.json<{
    skill_id: string;
    endpoint_id: string;
    rating: number;
  }>();
  if (!skill_id || !endpoint_id || rating == null) {
    return c.json({ error: "skill_id, endpoint_id, and rating required" }, 400);
  }
  const avgRating = await recordFeedback(c.env, skill_id, endpoint_id, rating);
  // Track agent contribution + activity in one queued profile write.
  const agentId = c.get("agent_id");
  if (agentId) {
    c.executionCtx.waitUntil(recordAgentFeedback(c.env, agentId));
  }
  // Surface the server-authoritative reliability the recompute just produced
  // so the client adopts the cross-user aggregate instead of re-deriving its
  // own single-client guess. Best-effort: never block the feedback ack on it.
  const reliability = await getServerReliability(c.env, skill_id, endpoint_id).catch(() => null);
  return c.json({ ok: true, avg_rating: avgRating, reliability });
});

// POST /v1/stats/reflect: agent reflect outcome to server-authoritative
// reliability update. The Bayesian smoothing runs server-side (it is a
// cross-user aggregate the client cannot compute); the response carries the
// recomputed authoritative reliability + staleness for the client to adopt.
statsRoutes.post("/stats/reflect", optionalAuth, async (c) => {
  const { skill_id, endpoint_id, intent_status } = await c.req.json<{
    skill_id: string;
    endpoint_id: string;
    intent_status: "achieved" | "partial" | "failed";
  }>();
  if (!skill_id || !endpoint_id || !intent_status) {
    return c.json({ error: "skill_id, endpoint_id, and intent_status required" }, 400);
  }
  if (intent_status !== "achieved" && intent_status !== "partial" && intent_status !== "failed") {
    return c.json({ error: "intent_status must be achieved | partial | failed" }, 400);
  }
  const reliability = await recordReflectionOutcome(c.env, skill_id, endpoint_id, intent_status);
  if (!reliability) {
    return c.json({ ok: false, error: "skill_or_endpoint_not_found" }, 404);
  }
  const agentId = c.get("agent_id");
  if (agentId) {
    c.executionCtx.waitUntil(recordAgentFeedback(c.env, agentId));
  }
  return c.json({ ok: true, reliability });
});

// GET /v1/stats/fees — aggregate graph fee summary (admin)
statsRoutes.get("/stats/fees", bearerAuth, async (c) => {
  try {
    const summary = await getFeesSummary(c.env);
    return c.json(summary);
  } catch (err) {
    console.error("[stats/fees] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/stats/fees/:agentId — per-agent fee ledger (admin)
statsRoutes.get("/stats/fees/:agentId", bearerAuth, async (c) => {
  const agentId = c.req.param("agentId");
  if (!agentId) return c.json({ error: "agentId required" }, 400);
  try {
    const ledger = await getAgentFeeLedger(c.env, agentId);
    if (!ledger) return c.json({ error: "no fee records for agent" }, 404);
    return c.json(ledger);
  } catch (err) {
    console.error("[stats/fees/:agentId] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/stats/attribution — aggregate Tier 1 attribution summary (admin)
statsRoutes.get("/stats/attribution", bearerAuth, async (c) => {
  try {
    const summary = await getAttributionSummary(c.env);
    return c.json(summary);
  } catch (err) {
    console.error("[stats/attribution] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});

// GET /v1/stats/attribution/:indexerId — per-indexer attribution ledger (admin)
statsRoutes.get("/stats/attribution/:indexerId", bearerAuth, async (c) => {
  const indexerId = c.req.param("indexerId");
  if (!indexerId) return c.json({ error: "indexerId required" }, 400);
  try {
    const ledger = await getIndexerLedger(c.env, indexerId);
    if (!ledger) return c.json({ error: "no attribution records for indexer" }, 404);
    return c.json(ledger);
  } catch (err) {
    console.error("[stats/attribution/:indexerId] error:", (err as Error).message);
    return c.json({ error: (err as Error).message }, 500);
  }
});
