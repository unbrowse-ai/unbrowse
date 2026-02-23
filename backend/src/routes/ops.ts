import { Hono } from "hono";
import type { Env } from "../types.js";
import { listSkills } from "../services/marketplace.js";
import { listAgents, countAgents } from "../services/agents.js";
import { skillsKV, statsKV } from "../services/kv.js";

export const opsRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/ops — single endpoint for the ops dashboard.
 * Returns stats + skills + agents in one Worker invocation so the
 * qdkv index cache is shared across all three reads.
 */
opsRoutes.get("/ops", async (c) => {
  const [skillEntries, statEntries, skills, agents] = await Promise.all([
    skillsKV(c.env).listWithValues("skill:"),
    statsKV(c.env).listWithValues("stats:"),
    listSkills(c.env),
    listAgents(c.env, 50),
  ]);

  let endpointCount = 0;
  const domainSet = new Set<string>();
  let totalExecutions = 0;

  for (const { value } of skillEntries) {
    try {
      const s = JSON.parse(value) as { endpoints?: unknown[]; domain?: string };
      endpointCount += s.endpoints?.length ?? 0;
      if (s.domain) domainSet.add(s.domain);
    } catch { /* skip */ }
  }
  for (const { value } of statEntries) {
    try {
      totalExecutions += (JSON.parse(value) as { total_executions?: number }).total_executions ?? 0;
    } catch { /* skip */ }
  }

  const agentCount = await countAgents(c.env);

  c.header("Cache-Control", "public, max-age=30");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({
    stats: {
      skills: skillEntries.length,
      endpoints: endpointCount,
      domains: domainSet.size,
      executions: totalExecutions,
      agents: agentCount,
    },
    skills,
    agents,
  });
});
