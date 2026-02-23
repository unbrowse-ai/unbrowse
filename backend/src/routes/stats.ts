import { Hono } from "hono";
import type { Env } from "../types.js";
import { recordExecution, recordFeedback } from "../services/scoring.js";
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
    const s = JSON.parse(value) as { endpoints?: unknown[]; domain?: string };
    endpointCount += s.endpoints?.length ?? 0;
    if (s.domain) domainSet.add(s.domain);
  }

  let totalExecutions = 0;
  for (const { value } of statEntries) {
    const s = JSON.parse(value) as { total_executions?: number };
    totalExecutions += s.total_executions ?? 0;
  }


  const agentCount = await countAgents(c.env);

  c.header("Cache-Control", "public, max-age=60");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({
    skills: skillCount,
    endpoints: endpointCount,
    domains: domainSet.size,
    executions: totalExecutions,
    agents: agentCount,
  });
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

