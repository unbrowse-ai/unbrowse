import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { AgentProfile, Env, SkillManifest } from "../src/types.js";
import { skillsKV, statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "local-test",
  UNKEY_ROOT_KEY: "local-test",
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

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer local-test",
  };
}

describe("analytics API routes", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await Promise.all([
      statsKV(env).resetSplitIndex(),
      skillsKV(env).resetSplitIndex(),
    ]);

    await seedAgent({
      agent_id: "agent-1",
      name: "agent-1",
      created_at: isoDaysAgo(10),
      skills_discovered: ["skill-a"],
      total_executions: 3,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(10),
      first_execution_at: isoDaysAgo(10),
      last_active_at: isoDaysAgo(1),
      activity_dates: [isoDaysAgo(10).slice(0, 10), isoDaysAgo(1).slice(0, 10)],
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
      ],
      lifecycle: "active",
      created_at: isoDaysAgo(10),
      updated_at: isoDaysAgo(0),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("ingests session/adoption data and exposes funnel + dashboard over HTTP", async () => {
    const adoptionRes = await app.fetch(new Request("http://local.test/v1/analytics/adoption", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        metric: "github_stars",
        value: 77,
      }),
    }), env);
    expect(adoptionRes.status).toBe(200);

    const sessionRes = await app.fetch(new Request("http://local.test/v1/analytics/sessions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        session_id: "sess-1",
        started_at: isoDaysAgo(1),
        completed_at: isoDaysAgo(1),
        api_calls: 4,
        discovery_queries: 1,
        cached_skill_calls: 1,
        fresh_index_calls: 0,
        browser_mode: "replaced",
      }),
    }), env);
    expect(sessionRes.status).toBe(200);

    const funnelRes = await app.fetch(new Request("http://local.test/v1/analytics/funnel?days=30", {
      headers: { Authorization: "Bearer local-test" },
    }), env);
    expect(funnelRes.status).toBe(200);
    const funnelBody = await funnelRes.json() as {
      stages: Array<{ key: string; users: number; eligible_users: number }>;
    };
    expect(funnelBody.stages.map((stage) => stage.key)).toEqual([
      "registered",
      "activated",
      "aha",
      "repeat",
      "retained_d7",
      "retained_d30",
    ]);
    expect(funnelBody.stages[0]?.users).toBe(1);
    expect(typeof funnelBody.stages[2]?.users).toBe("number");

    const dashboardRes = await app.fetch(new Request("http://local.test/v1/analytics/dashboard", {
      headers: { Authorization: "Bearer local-test" },
    }), env);
    expect(dashboardRes.status).toBe(200);
    const dashboard = await dashboardRes.json() as Record<string, unknown>;
    expect(dashboard).toHaveProperty("growth");
    expect(dashboard).toHaveProperty("usage");
    expect(dashboard).toHaveProperty("funnel");
    expect(dashboard).toHaveProperty("economics");
  });

  it("serves all analytics read routes and enforces admin-only writes", async () => {
    const nonAdminPricing = await app.fetch(new Request("http://local.test/v1/analytics/pricing", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer non-admin-token",
      },
      body: JSON.stringify({ route_price_usd: 0.01 }),
    }), env);
    expect(nonAdminPricing.status).toBe(403);

    const nonAdminAdoption = await app.fetch(new Request("http://local.test/v1/analytics/adoption", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer non-admin-token",
      },
      body: JSON.stringify({ metric: "npm_installs", value: 12 }),
    }), env);
    expect(nonAdminAdoption.status).toBe(403);

    const pricingWrite = await app.fetch(new Request("http://local.test/v1/analytics/pricing", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        route_price_usd: 0.009,
        discovery_price_usd: 0.03,
        monthly_fixed_cost_usd: 250,
      }),
    }), env);
    expect(pricingWrite.status).toBe(200);

    const pricingRead = await app.fetch(new Request("http://local.test/v1/analytics/pricing", {
      headers: { Authorization: "Bearer local-test" },
    }), env);
    expect(pricingRead.status).toBe(200);
    expect(await pricingRead.json()).toMatchObject({
      route_price_usd: 0.009,
      discovery_price_usd: 0.03,
      monthly_fixed_cost_usd: 250,
    });

    const routes = [
      "/v1/analytics/growth",
      "/v1/analytics/engagement",
      "/v1/analytics/retention",
      "/v1/analytics/usage",
      "/v1/analytics/funnel",
      "/v1/analytics/network",
      "/v1/analytics/economics",
      "/v1/analytics/activation",
      "/v1/analytics/agents",
    ];

    for (const path of routes) {
      const res = await app.fetch(new Request(`http://local.test${path}`, {
        headers: { Authorization: "Bearer local-test" },
      }), env);
      expect(res.status).toBe(200);
      const body = await res.json() as unknown;
      expect(body).toBeDefined();
    }
  });
});
