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
import { skillsKV, statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
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

describe("fundraising metrics", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await Promise.all([
      statsKV(env).resetSplitIndex(),
      skillsKV(env).resetSplitIndex(),
    ]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("derives growth, usage, network health, and economics from API-trackable state", async () => {
    await seedAgent({
      agent_id: "agent-new",
      name: "agent-new",
      created_at: isoDaysAgo(2),
      skills_discovered: ["skill-a"],
      total_executions: 3,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(2),
      first_execution_at: isoDaysAgo(2),
      last_active_at: isoDaysAgo(0),
      activity_dates: [isoDaysAgo(2).slice(0, 10), isoDaysAgo(0).slice(0, 10)],
    });
    await seedAgent({
      agent_id: "agent-old",
      name: "agent-old",
      created_at: isoDaysAgo(12),
      skills_discovered: ["skill-b"],
      total_executions: 1,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(12),
      first_execution_at: isoDaysAgo(12),
      last_active_at: isoDaysAgo(4),
      activity_dates: [isoDaysAgo(12).slice(0, 10), isoDaysAgo(4).slice(0, 10)],
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
        { endpoint_id: "alpha", method: "GET", url_template: "https://other.com/a", idempotency: "safe", verification_status: "verified", reliability_score: 0.9, description: "alpha" },
      ],
      lifecycle: "active",
      created_at: isoDaysAgo(10),
      updated_at: isoDaysAgo(0),
    });

    await recordAdoptionSnapshot(env, { metric: "npm_installs", value: 120, captured_at: isoDaysAgo(1) });
    await recordAdoptionSnapshot(env, { metric: "github_stars", value: 42, captured_at: isoDaysAgo(1) });

    await recordSessionSummary(env, "agent-new", {
      session_id: "s1",
      started_at: isoDaysAgo(1),
      completed_at: isoDaysAgo(1),
      trace_version: "v2@aaa111",
      api_calls: 6,
      discovery_queries: 2,
      cached_skill_calls: 5,
      fresh_index_calls: 1,
      browser_mode: "replaced",
    });
    await recordSessionSummary(env, "agent-old", {
      session_id: "s2",
      started_at: isoDaysAgo(5),
      completed_at: isoDaysAgo(5),
      trace_version: "v1@zzz999",
      api_calls: 2,
      discovery_queries: 1,
      cached_skill_calls: 0,
      fresh_index_calls: 1,
      browser_mode: "manual",
    });
    await recordSessionSummary(env, "agent-new", {
      session_id: "s3",
      started_at: isoDaysAgo(0),
      completed_at: isoDaysAgo(0),
      trace_version: "v2@aaa111",
      api_calls: 1,
      discovery_queries: 0,
      cached_skill_calls: 1,
      fresh_index_calls: 0,
      browser_mode: "replaced",
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
    await recordPerf(env, {
      search_ms: 100,
      get_skill_ms: 40,
      execute_ms: 3_000,
      total_ms: 4_000,
      source: "live-capture",
      cache_hit: false,
      candidates_found: 0,
      candidates_tried: 1,
      tokens_saved: 0,
      response_bytes: 1_200,
      time_saved_pct: 0,
      tokens_saved_pct: 0,
    });

    await recordGraphFee(env, "agent-new", "search");
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

    expect(growth.cumulative_users).toBe(2);
    expect(growth.npm_install_trend.at(-1)?.value).toBe(120);
    expect(growth.github_star_trend.at(-1)?.value).toBe(42);

    expect(usage.total_sessions_30d).toBe(3);
    expect(usage.api_calls_per_session).toBe(3);
    expect(usage.repeat_usage_rate).toBe(1);
    expect(usage.churn_post_default_browser_replacement).toBe(0);
    expect(usage.version_breakdown_30d[0]).toEqual({
      trace_version: "v2@aaa111",
      sessions: 2,
      agents: 1,
      api_calls: 7,
    });

    expect(funnel.stages[0]?.users).toBe(2);
    expect(funnel.stages[1]?.users).toBe(2);
    expect(funnel.stages[2]?.users).toBe(1);
    expect(funnel.stages[3]?.users).toBe(2);
    expect(funnel.stages[4]?.users).toBe(1);
    expect(funnel.stages[4]?.eligible_users).toBe(1);
    expect(funnel.stages[5]?.eligible_users).toBe(0);

    expect(network.total_indexed_skills).toBe(2);
    expect(network.total_indexed_endpoints).toBe(3);
    expect(network.coverage_breadth).toBe(2);
    expect(network.fresh_index_calls).toBe(1);
    expect(network.skill_reuse_rate).toBe(0.67);

    expect(pricing.monthly_fixed_cost_usd).toBe(500);
    expect(economics.route_calls_30d).toBe(9);
    expect(economics.discovery_queries_30d).toBe(3);
    expect(economics.revenue_per_route_usd).toBe(0.005);
    expect(economics.revenue_per_discovery_query_usd).toBe(0.02);
    expect(economics.required_route_volume_for_target_revenue).toBe(20_000_000);
    expect(economics.break_even_user_count).toBeGreaterThan(0);
    expect(economics.cost_savings_per_action_usd).toBeGreaterThan(0);
    expect(economics.speedup_multiplier).toBeGreaterThan(1);
  });
});
