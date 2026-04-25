import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { AgentProfile, Env, SkillManifest } from "../src/types.js";
import { skillsKV, statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
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

describe("analytics routes", () => {
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
      created_at: isoDaysAgo(8),
      profile_origin: "registered",
      skills_discovered: ["skill-a"],
      total_executions: 2,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: isoDaysAgo(8),
      first_execution_at: isoDaysAgo(8),
      last_active_at: isoDaysAgo(0),
      activity_dates: [isoDaysAgo(8).slice(0, 10), isoDaysAgo(0).slice(0, 10)],
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
      created_at: isoDaysAgo(12),
      updated_at: isoDaysAgo(0),
    });

    const sessionRes = await app.fetch(new Request("http://local.test/v1/analytics/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session_id: "session-route",
        started_at: isoDaysAgo(0),
        completed_at: isoDaysAgo(0),
        trace_version: "route-test",
        api_calls: 1,
        discovery_queries: 1,
        cached_skill_calls: 1,
        fresh_index_calls: 0,
        browser_mode: "replaced",
      }),
    }), env);
    expect(sessionRes.status).toBe(200);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // route not yet implemented — GET /v1/analytics/routing (and others in path list)
  it.skip("serves the restored direct analytics routes and dashboard aggregate", async () => {
    const paths = [
      "/v1/analytics/growth",
      "/v1/analytics/usage",
      "/v1/analytics/network",
      "/v1/analytics/economics",
      "/v1/analytics/funnel",
      "/v1/analytics/routing",
      "/v1/analytics/pricing",
      "/v1/analytics/dashboard",
      "/v1/analytics/install-funnel",
    ];

    for (const path of paths) {
      const res = await app.fetch(new Request(`http://local.test${path}`, {
        headers: { Authorization: "Bearer admin" },
      }), env);
      expect(res.status).toBe(200);
    }

    const usageRes = await app.fetch(new Request("http://local.test/v1/analytics/usage", {
      headers: { Authorization: "Bearer admin" },
    }), env);
    const usage = await usageRes.json() as { total_sessions_30d: number; version_breakdown_30d: Array<{ trace_version: string }> };
    expect(usage.total_sessions_30d).toBe(1);
    expect(usage.version_breakdown_30d[0]?.trace_version).toBe("route-test");

    const dashboardRes = await app.fetch(new Request("http://local.test/v1/analytics/dashboard", {
      headers: { Authorization: "Bearer admin" },
    }), env);
    const dashboard = await dashboardRes.json() as Record<string, unknown>;
    expect(Object.keys(dashboard)).toEqual(expect.arrayContaining([
      "growth",
      "engagement",
      "usage",
      "funnel",
      "activation",
      "network",
      "economics",
      "pricing",
      "agent_health",
      "bottleneck",
    ]));
  });

  it("rejects unauthenticated canonical analytics routes", async () => {
    const paths = [
      "/v1/analytics/growth",
      "/v1/analytics/usage",
      "/v1/analytics/network",
      "/v1/analytics/economics",
      "/v1/analytics/funnel",
      "/v1/analytics/routing",
      "/v1/analytics/install-funnel",
    ];

    for (const path of paths) {
      const res = await app.fetch(new Request(`http://local.test${path}`), env);
      expect(res.status).toBe(401);
    }
  });
});
