import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { AgentProfile, Env, SkillManifest } from "../src/types.js";
import { skillsKV, statsKV } from "../src/services/kv.js";

const responseCacheStore = new Map<string, string>();
let responseCacheGets = 0;
const responseCache = {
  get: async (key: string) => {
    responseCacheGets++;
    return responseCacheStore.get(key) ?? null;
  },
  put: async (key: string, value: string) => { responseCacheStore.set(key, value); },
  delete: async (key: string) => { responseCacheStore.delete(key); },
  list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
  getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
} as unknown as KVNamespace;

const env: Env = {
  API_KEY: "local-test",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
  INTERNAL_AUTH_PASSWORD: "dashboard-test",
  RESPONSE_CACHE: responseCache,
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
    responseCacheStore.clear();
    responseCacheGets = 0;
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
      indexer_id: "agent-1",
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
        trace_version: "test-trace@123",
        api_calls: 4,
        discovery_queries: 1,
        cached_skill_calls: 1,
        fresh_index_calls: 0,
        browser_mode: "replaced",
        surface: "local-http",
        execution_scope: "mixed",
        telemetry_schema_version: 1,
      }),
    }), env);
    expect(sessionRes.status).toBe(200);
    const untrustedSessionRes = await app.fetch(new Request("http://local.test/v1/analytics/sessions", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        session_id: "sess-untrusted",
        started_at: isoDaysAgo(1),
        trace_version: "session-person@example.com / Bearer session-secret-canary",
        api_calls: 2,
      }),
    }), env);
    expect(untrustedSessionRes.status).toBe(200);

    const issuePingRes = await app.fetch(new Request("http://local.test/v1/telemetry/issue", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        surface: "private-surface@example.com",
        kind: "private-kind@example.com",
        message: "https://private.example/Bearer-issue-secret-canary",
        context: { path: "/private-account", token: "issue-secret-canary" },
        session_id: "issue-secret-canary",
        version: "Bearer issue-secret-canary",
      }),
    }), env);
    expect(issuePingRes.status).toBe(200);

    const usagePingRes = await app.fetch(new Request("http://local.test/v1/telemetry/usage", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        verb: "get",
        operation: "breath:get",
        version: "11.4.0",
        install_id: "aaaaaaaaaaaaaaaa",
        surface: "cli",
        execution_scope: "local",
        telemetry_schema_version: 2,
      }),
    }), env);
    expect(usagePingRes.status).toBe(200);
    const untrustedUsagePingRes = await app.fetch(new Request("http://local.test/v1/telemetry/usage", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        verb: "usage-person@example.com",
        operation: "private:usage_secret_canary",
        version: "Bearer usage-secret-canary",
        install_id: "usage-person@example.com",
      }),
    }), env);
    expect(untrustedUsagePingRes.status).toBe(200);

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
    expect((dashboard.usage as { version_breakdown_30d?: Array<{ trace_version: string }> }).version_breakdown_30d)
      .toContainEqual(expect.objectContaining({ trace_version: "test-trace@123" }));

    const reportRes = await app.fetch(new Request("http://local.test/v1/analytics/report?days=7", {
      headers: { Authorization: "Bearer local-test" },
    }), env);
    expect(reportRes.status).toBe(200);
    expect(reportRes.headers.get("cache-control")).toBe("private, no-store");
    expect(reportRes.headers.get("x-cache")).toBe("MISS");
    const report = await reportRes.json() as {
      requested_window_days: number;
      engagement: { registered_agents: number; windows: { mau_days: number } };
      retention: {
        requested_days: number;
        cohort_age_days: { min: number; max: number };
        cohorts: Array<{ cohort_date: string }>;
      };
      churn: { churn_rate_30d: number; product_churn_window_days: number };
      user_split: { normal_users: null; unclassified_non_creator_users: number; agent_creators: number; business_users: null };
      usage: {
        session_window_days: number;
        sessions_30d?: { telemetry_schema_coverage_30d?: number; observed_by_surface_30d?: Array<{ key: string; count: number }> };
        cloud_service?: { configured: boolean; unavailable_reason?: string };
        cli_invocation_window_days: number;
        observed_use_cases: Array<{ key: string; count: number }>;
        detailed_intents_available: boolean;
      };
    };
    expect(report.requested_window_days).toBe(7);
    expect(report.engagement).toMatchObject({ registered_agents: 1, windows: { mau_days: 30 } });
    expect(report.retention).toMatchObject({ requested_days: 7, cohort_age_days: { min: 2, max: 37 } });
    expect(report.retention.cohorts.every((cohort) =>
      cohort.cohort_date >= isoDaysAgo(37).slice(0, 10) && cohort.cohort_date <= isoDaysAgo(2).slice(0, 10)
    )).toBe(true);
    expect(report.churn).toMatchObject({ churn_rate_30d: 0, product_churn_window_days: 30 });
    expect(report.usage).toMatchObject({
      session_window_days: 30,
      cli_invocation_window_days: 7,
      sessions_30d: { total_api_calls_30d: 6 },
    });
    expect(report.user_split).toMatchObject({
      normal_users: null,
      business_users: null,
      unclassified_non_creator_users: 0,
      agent_creators: 1,
    });
    expect(report.usage.observed_use_cases).toContainEqual({ key: "get", count: 1 });
    expect(report.usage.observed_use_cases).toContainEqual({ key: "other", count: 1 });
    expect(JSON.stringify(report)).not.toContain("person@example.com");
    expect(JSON.stringify(report)).not.toContain("secret-canary");
    expect(JSON.stringify(report)).not.toContain("session-secret-canary");
    expect(report.usage.detailed_intents_available).toBe(false);
    expect(report.usage.sessions_30d?.telemetry_schema_coverage_30d).toBe(0.5);
    expect(report.usage.sessions_30d?.observed_by_surface_30d).toContainEqual({ key: "local-http", count: 1 });
    expect(report.usage.cloud_service).toMatchObject({ configured: false, unavailable_reason: "not_configured" });

    const internalRes = await app.fetch(new Request("http://local.test/v1/analytics/internal?days=90", {
      headers: { Authorization: "Bearer dashboard-test" },
    }), env);
    expect(internalRes.status).toBe(200);
    expect(internalRes.headers.get("cache-control")).toBe("private, no-store");
    const internal = await internalRes.json() as {
      window_days: number;
      privacy: { detailed_intents_available: boolean };
      sources: Record<string, { available: boolean }>;
      activity: {
        by_operation: Array<{ key: string; count: number }>;
        by_use_case: Array<{ key: string; count: number }>;
        operation_detail_coverage: number;
      };
      issues: { by_kind: Array<{ key: string; count: number }>; by_surface: Array<{ key: string; count: number }> };
    };
    expect(internal.window_days).toBe(90);
    expect(internal.privacy.detailed_intents_available).toBe(false);
    expect(internal.sources.activity.available).toBe(true);
    expect(internal.activity.by_operation).toContainEqual({ key: "breath:get", count: 1 });
    expect(internal.activity.by_operation).toContainEqual({ key: "other", count: 1 });
    expect(internal.activity.by_use_case).toContainEqual({ key: "research_retrieval", count: 1 });
    expect(internal.activity.operation_detail_coverage).toBe(0.5);
    expect(internal.issues.by_kind).toContainEqual({ key: "unknown", count: 1 });
    expect(internal.issues.by_surface).toContainEqual({ key: "unknown", count: 1 });
    expect(internal.issues).not.toHaveProperty("recent");
    expect(JSON.stringify(internal)).not.toContain("usage-person@example.com");
    expect(JSON.stringify(internal)).not.toContain("usage-secret-canary");
    expect(JSON.stringify([...store.entries()])).not.toContain("usage-person@example.com");
    expect(JSON.stringify([...store.entries()])).not.toContain("usage-secret-canary");
    expect(JSON.stringify([...store.entries()])).not.toContain("issue-secret-canary");

    const cachedRow = responseCacheStore.get("cache:analytics-report:v1:7");
    expect(cachedRow).toBeDefined();
    expect(cachedRow).not.toContain("person@example.com");
    expect(cachedRow).not.toContain("secret-canary");

    const cachedReportRes = await app.fetch(new Request("http://local.test/v1/analytics/report?days=7", {
      headers: { Authorization: "Bearer local-test" },
    }), env);
    expect(cachedReportRes.status).toBe(200);
    expect(cachedReportRes.headers.get("x-cache")).toBe("HIT");
    expect(cachedReportRes.headers.get("etag")).toBe(reportRes.headers.get("etag"));

    const bypassReportRes = await app.fetch(new Request("http://local.test/v1/analytics/report?days=7", {
      headers: { Authorization: "Bearer local-test", "Cache-Control": "no-cache" },
    }), env);
    expect(bypassReportRes.status).toBe(200);
    expect(bypassReportRes.headers.get("x-cache")).toBe("BYPASS");

    const clampedReportRes = await app.fetch(new Request("http://local.test/v1/analytics/report?days=0", {
      headers: { Authorization: "Bearer local-test" },
    }), env);
    expect(clampedReportRes.status).toBe(200);
    expect((await clampedReportRes.json() as { requested_window_days: number }).requested_window_days).toBe(1);

    const cappedReportRes = await app.fetch(new Request("http://local.test/v1/analytics/report?days=999", {
      headers: { Authorization: "Bearer local-test" },
    }), env);
    expect(cappedReportRes.status).toBe(200);
    expect((await cappedReportRes.json() as { requested_window_days: number }).requested_window_days).toBe(180);
  });

  it("serves all analytics read routes and enforces auth and admin-only writes", async () => {
    responseCacheStore.set("cache:analytics-report:v1:30", JSON.stringify({
      _cached_at: Date.now(),
      _ttl_sec: 60,
      _etag: "0000000000000000",
      value: { canary: "must-not-leak" },
    }));
    const cacheGetsBeforeRejectedRequests = responseCacheGets;
    const unauthenticatedReport = await app.fetch(
      new Request("http://local.test/v1/analytics/report"),
      env,
    );
    expect(unauthenticatedReport.status).toBe(403);
    const unauthenticatedInternal = await app.fetch(
      new Request("http://local.test/v1/analytics/internal"),
      env,
    );
    expect(unauthenticatedInternal.status).toBe(403);
    expect(unauthenticatedReport.headers.get("cache-control")).toBe("private, no-store");
    expect(unauthenticatedReport.headers.get("vary")).toBe("Authorization");

    const malformedDashboardAuth = await app.fetch(new Request("http://local.test/v1/analytics/report", {
      headers: { Authorization: "dashboard-test" },
    }), env);
    expect(malformedDashboardAuth.status).toBe(403);

    const nonAdminReport = await app.fetch(new Request("http://local.test/v1/analytics/report", {
      headers: { Authorization: "Bearer non-admin-token" },
    }), env);
    expect(nonAdminReport.status).toBe(403);
    expect(responseCacheGets).toBe(cacheGetsBeforeRejectedRequests);

    responseCacheStore.clear();
    const dashboardReport = await app.fetch(new Request("http://local.test/v1/analytics/report", {
      headers: { Authorization: "Bearer dashboard-test" },
    }), env);
    expect(dashboardReport.status).toBe(200);
    expect(dashboardReport.headers.get("cache-control")).toBe("private, no-store");

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
      "/v1/analytics/report",
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
