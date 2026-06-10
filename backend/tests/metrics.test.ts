import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentProfile, Env, SkillManifest } from "../src/types.js";
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
} from "../src/services/metrics.js";
import { recordGraphFee } from "../src/services/fees.js";
import { recordPerf } from "../src/services/perf.js";
import { clearKVCacheForTests, skillsKV, statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
};

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(12, 0, 0, 0);
  return date.toISOString();
}

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(value == null
        ? { found: false, value: null }
        : { found: true, value });
    }

    if (url.pathname.startsWith("/qdkv/del/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

async function seedAgent(profile: AgentProfile): Promise<void> {
  await statsKV(env).put(`agent:${profile.agent_id}`, JSON.stringify(profile));
}

async function seedSkill(skill: SkillManifest): Promise<void> {
  await skillsKV(env).put(`skill:${skill.skill_id}`, JSON.stringify(skill));
}

describe("canonical analytics metrics", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    clearKVCacheForTests("stats");
    clearKVCacheForTests("skills-v2");
    await Promise.all([
      statsKV(env).resetSplitIndex(),
      skillsKV(env).resetSplitIndex(),
    ]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("restores growth, usage, network, and economics while keeping the funnel monotonic", async () => {
    await seedAgent({
      agent_id: "agent-repeat",
      name: "agent-repeat",
      created_at: isoDaysAgo(8),
      profile_origin: "registered",
      skills_discovered: ["skill-a"],
      total_executions: 4,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(8),
      first_execution_at: isoDaysAgo(8),
      last_active_at: isoDaysAgo(0),
      activity_dates: [isoDaysAgo(8).slice(0, 10), isoDaysAgo(0).slice(0, 10)],
    });
    await seedAgent({
      agent_id: "agent-activated-no-session",
      name: "agent-activated-no-session",
      created_at: isoDaysAgo(2),
      profile_origin: "registered",
      skills_discovered: ["skill-b"],
      total_executions: 1,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(2),
      first_execution_at: isoDaysAgo(2),
      last_active_at: isoDaysAgo(1),
      activity_dates: [isoDaysAgo(1).slice(0, 10)],
    });
    await seedAgent({
      agent_id: "agent-recovered",
      name: "agent-recovered",
      created_at: isoDaysAgo(1),
      profile_origin: "recovered",
      recovered_at: isoDaysAgo(1),
      skills_discovered: ["skill-c"],
      total_executions: 0,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(1),
      activity_dates: [],
    });

    await seedSkill({
      skill_id: "skill-a",
      version: "1.0.0",
      schema_version: "1",
      name: "example.com",
      intent_signature: "example.com",
      domain: "example.com",
      description: "Example domain",
      owner_type: "agent",
      execution_type: "http",
      endpoints: [
        { endpoint_id: "one", method: "GET", url_template: "https://example.com/one", idempotency: "safe", verification_status: "verified", reliability_score: 0.9, description: "one" },
        { endpoint_id: "two", method: "GET", url_template: "https://example.com/two", idempotency: "safe", verification_status: "verified", reliability_score: 0.9, description: "two" },
      ],
      lifecycle: "active",
      created_at: isoDaysAgo(12),
      updated_at: isoDaysAgo(0),
    });
    await seedSkill({
      skill_id: "skill-b",
      version: "1.0.0",
      schema_version: "1",
      name: "other.com",
      intent_signature: "other.com",
      domain: "other.com",
      description: "Other domain",
      owner_type: "agent",
      execution_type: "http",
      endpoints: [
        { endpoint_id: "alpha", method: "GET", url_template: "https://other.com/a", idempotency: "safe", verification_status: "verified", reliability_score: 0.95, description: "alpha" },
      ],
      lifecycle: "active",
      created_at: isoDaysAgo(10),
      updated_at: isoDaysAgo(0),
    });

    await recordAdoptionSnapshot(env, { metric: "npm_installs", value: 120, captured_at: isoDaysAgo(1) });
    await recordAdoptionSnapshot(env, { metric: "github_stars", value: 42, captured_at: isoDaysAgo(1) });

    await recordSessionSummary(env, "agent-repeat", {
      session_id: "session-1",
      started_at: isoDaysAgo(1),
      completed_at: isoDaysAgo(1),
      trace_version: "v-new",
      api_calls: 1,
      discovery_queries: 1,
      cached_skill_calls: 1,
      fresh_index_calls: 0,
      browser_mode: "replaced",
    });
    await recordSessionSummary(env, "agent-repeat", {
      session_id: "session-2",
      started_at: isoDaysAgo(0),
      completed_at: isoDaysAgo(0),
      trace_version: "v-new",
      api_calls: 1,
      discovery_queries: 0,
      cached_skill_calls: 0,
      fresh_index_calls: 1,
      browser_mode: "manual",
    });

    await recordPerf(env, {
      search_ms: 40,
      get_skill_ms: 20,
      execute_ms: 300,
      total_ms: 800,
      source: "marketplace",
      cache_hit: false,
      candidates_found: 3,
      candidates_tried: 1,
      tokens_saved: 11_800,
      response_bytes: 800,
      time_saved_pct: 98,
      tokens_saved_pct: 98,
    });
    await recordPerf(env, {
      search_ms: 80,
      get_skill_ms: 20,
      execute_ms: 500,
      total_ms: 1_200,
      source: "route-cache",
      cache_hit: true,
      candidates_found: 2,
      candidates_tried: 1,
      tokens_saved: 11_600,
      response_bytes: 600,
      time_saved_pct: 97,
      tokens_saved_pct: 96,
    });

    await recordGraphFee(env, "agent-repeat", "search");
    await saveRevenuePricing(env, {
      route_price_usd: 0.005,
      discovery_price_usd: 0.02,
      monthly_fixed_cost_usd: 500,
    });

    const [growth, usage, funnel, network, economics, pricing] = await Promise.all([
      getGrowthMetrics(env, 14),
      getUsageMetrics(env),
      getOptimizationFunnel(env, 30),
      getNetworkHealthMetrics(env),
      getUnitEconomicsMetrics(env),
      getRevenuePricing(env),
    ]);

    expect(growth.cumulative_users).toBe(3);
    expect(growth.npm_install_trend.at(-1)?.value).toBe(120);
    expect(growth.github_star_trend.at(-1)?.value).toBe(42);

    expect(usage.total_sessions_30d).toBe(2);
    expect(usage.unique_agents_30d).toBe(1);
    expect(usage.api_calls_per_session).toBe(1);
    expect(usage.version_breakdown_30d[0]).toEqual({
      trace_version: "v-new",
      sessions: 2,
      agents: 1,
      api_calls: 2,
    });

    expect(funnel.recovered_profiles_excluded).toBe(1);
    expect(funnel.data_quality_warnings).toContain("missing_session_coverage_for_some_activated_users");
    expect(funnel.stages.map((stage) => stage.users)).toEqual([2, 2, 1, 1, 1, 0]);
    expect(funnel.stages[4]?.eligible_users).toBe(1);
    expect(funnel.stages[5]?.eligible_users).toBe(0);

    expect(network.total_indexed_skills).toBe(2);
    expect(network.total_indexed_endpoints).toBe(3);
    expect(network.coverage_breadth).toBe(2);
    expect(network.indexed_skill_calls).toBe(1);
    expect(network.fresh_index_calls).toBe(1);
    expect(network.skill_reuse_rate).toBe(0.5);

    expect(pricing.monthly_fixed_cost_usd).toBe(500);
    expect(economics.route_calls_30d).toBe(2);
    expect(economics.discovery_queries_30d).toBe(1);
    expect(economics.revenue_per_route_usd).toBe(0.005);
    expect(economics.revenue_per_discovery_query_usd).toBe(0.02);
    expect(economics.required_route_volume_for_target_revenue).toBe(20_000_000);
    expect(economics.break_even_user_count).toBeGreaterThan(0);
    expect(economics.cost_savings_per_action_usd).toBeGreaterThan(0);
    expect(economics.speedup_multiplier).toBeGreaterThan(1);
  });
});
