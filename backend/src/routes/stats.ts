import { Hono } from "hono";
import type { Env } from "../types.js";
import { recordExecution, recordFeedback } from "../services/scoring.js";
import { validateSkillManifest } from "../services/validator.js";
import { incrementAgentExecutions, incrementAgentFeedback, countAgents } from "../services/agents.js";
import { rateLimit, agentRateLimit } from "../middleware/rate-limit.js";

// Public stats — no auth required
export const publicStatsRoutes = new Hono<{ Bindings: Env }>();

// GET /v1/stats/summary — aggregated counts for the landing page
publicStatsRoutes.get("/stats/summary", async (c) => {
  let skillCount = 0;
  let endpointCount = 0;
  const domainSet = new Set<string>();
  let cursor: string | undefined;

  do {
    const list = await c.env.SKILLS_KV.list({ prefix: "skill:", limit: 1000, cursor });
    skillCount += list.keys.length;

    const samplesToRead = list.keys.slice(0, 50);
    const reads = await Promise.all(
      samplesToRead.map((k) => c.env.SKILLS_KV.get(k.name, "json"))
    );
    for (const skill of reads) {
      if (skill && typeof skill === "object") {
        const s = skill as { endpoints?: unknown[]; domain?: string };
        endpointCount += s.endpoints?.length ?? 0;
        if (s.domain) domainSet.add(s.domain);
      }
    }

    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  // Count total executions
  let totalExecutions = 0;
  let statsCursor: string | undefined;
  do {
    const list = await c.env.STATS_KV.list({ prefix: "stats:", limit: 1000, cursor: statsCursor });
    const reads = await Promise.all(
      list.keys.slice(0, 100).map((k) => c.env.STATS_KV.get(k.name, "json"))
    );
    for (const stat of reads) {
      if (stat && typeof stat === "object") {
        totalExecutions += (stat as { total_executions?: number }).total_executions ?? 0;
      }
    }
    statsCursor = list.list_complete ? undefined : list.cursor;
  } while (statsCursor);

  // Extrapolate endpoint count if we only sampled a subset
  const sampledSkills = Math.min(skillCount, 50);
  if (sampledSkills > 0 && sampledSkills < skillCount) {
    const avgEndpoints = endpointCount / sampledSkills;
    endpointCount = Math.round(avgEndpoints * skillCount);
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

publicValidateRoutes.use("/validate", rateLimit({ limit: 20, window: 60, prefix: "validate" }));

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

