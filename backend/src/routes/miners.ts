import { Hono } from "hono";
import type { Env } from "../types.js";
import { skillsKV, statsKV } from "../services/kv.js";
import { countAgents } from "../services/agents.js";
import { getPerf } from "../services/perf.js";
import { buildLeaderboard } from "../services/economics.js";
import { buildMinerDemandBoard } from "../services/miner-demand.js";

export const publicMinerRoutes = new Hono<{ Bindings: Env }>();

// GET /v1/miners/stats — aggregated miner-specific stats for the leaderboard page
publicMinerRoutes.get("/miners/stats", async (c) => {
  const [skillEntries, statEntries, agentCount, perfStats, leaderboard] = await Promise.all([
    skillsKV(c.env).listWithValues("skill:"),
    statsKV(c.env).listWithValues("stats:"),
    countAgents(c.env),
    getPerf(c.env),
    buildLeaderboard(c.env, 100),
  ]);

  // Domain coverage: per-domain skill & endpoint counts
  const domainMap = new Map<string, { domain: string; skills: number; endpoints: number; updated_at: string }>();
  let totalSkills = 0;
  let totalEndpoints = 0;

  for (const { value } of skillEntries) {
    try {
      const s = JSON.parse(value) as {
        domain?: string;
        endpoints?: unknown[];
        lifecycle?: string;
        updated_at?: string;
        indexer_id?: string;
      };
      if (s.lifecycle === "deprecated" || s.lifecycle === "disabled") continue;
      totalSkills++;
      const epCount = s.endpoints?.length ?? 0;
      totalEndpoints += epCount;
      if (s.domain) {
        const existing = domainMap.get(s.domain);
        if (existing) {
          existing.skills++;
          existing.endpoints += epCount;
          if (s.updated_at && s.updated_at > existing.updated_at) {
            existing.updated_at = s.updated_at;
          }
        } else {
          domainMap.set(s.domain, {
            domain: s.domain,
            skills: 1,
            endpoints: epCount,
            updated_at: s.updated_at ?? new Date().toISOString(),
          });
        }
      }
    } catch { /* skip malformed */ }
  }

  let totalExecutions = 0;
  for (const { value } of statEntries) {
    try {
      const s = JSON.parse(value) as { total_executions?: number };
      totalExecutions += s.total_executions ?? 0;
    } catch { /* skip malformed */ }
  }

  // Total x402 earned across all miners
  const totalEarnedUsd = leaderboard.reduce((sum, e) => sum + e.total_earned_usd, 0);

  // Domain coverage sorted by endpoint count
  const domains = Array.from(domainMap.values())
    .sort((a, b) => b.endpoints - a.endpoints);
  const { bounties, quests } = await buildMinerDemandBoard(c.env, new Map(
    domains.map((domain) => [domain.domain.replace(/^www\./, ""), { endpoints: domain.endpoints, skills: domain.skills }]),
  ));

  c.header("Cache-Control", "public, max-age=30");
  c.header("Access-Control-Allow-Origin", "*");
  return c.json({
    network: {
      total_routes: totalEndpoints,
      total_skills: totalSkills,
      total_agents: agentCount,
      total_executions: totalExecutions,
      total_earned_usd: totalEarnedUsd,
      marketplace_hit_rate: perfStats.total_resolves > 0
        ? Math.round((perfStats.marketplace_hits + perfStats.cache_hits) / perfStats.total_resolves * 100)
        : 0,
      total_resolves: perfStats.total_resolves,
      total_tokens_saved: perfStats.total_tokens_saved,
    },
    domains,
    leaderboard: leaderboard.slice(0, 50),
    bounties,
    quests,
  });
});
