import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";
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

function skill(skill_id: string, domain: string): SkillManifest {
  return {
    skill_id,
    version: "1.0.0",
    schema_version: "1",
    name: domain,
    intent_signature: domain,
    domain,
    description: `Fixture for ${domain}`,
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    created_at: "2026-03-10T00:00:00.000Z",
    updated_at: "2026-03-10T00:00:00.000Z",
    endpoints: [
      {
        endpoint_id: `${skill_id}-ep`,
        method: "GET",
        url_template: `https://${domain}/api`,
        description: `Data from ${domain}`,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
    ],
  };
}

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== "api.emergentdb.com") {
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }

    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }

    if (url.pathname.startsWith("/qdkv/get/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
      const value = store.get(key);
      return Response.json(value == null ? { found: false, value: null } : { found: true, value });
    }

    if (url.pathname.startsWith("/qdkv/del/")) {
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

describe("GET /v1/analytics/usage", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await Promise.all([
      skillsKV(env).resetSplitIndex(),
      statsKV(env).resetSplitIndex(),
    ]);

    await skillsKV(env).put("skill:skill-example", JSON.stringify(skill("skill-example", "example.com")));
    await skillsKV(env).put("skill:skill-news", JSON.stringify(skill("skill-news", "news.ycombinator.com")));

    await statsKV(env).put("stats:skill-example--skill-example-ep", JSON.stringify({
      total_executions: 9,
      successful_executions: 8,
      consecutive_failures: 0,
      avg_latency_ms: 120,
      feedback_sum: 0,
      feedback_count: 0,
      drift_count: 0,
      last_execution_at: "2026-03-12T18:00:00.000Z",
    }));
    await statsKV(env).put("stats:skill-news--skill-news-ep", JSON.stringify({
      total_executions: 3,
      successful_executions: 3,
      consecutive_failures: 0,
      avg_latency_ms: 95,
      feedback_sum: 0,
      feedback_count: 0,
      drift_count: 0,
      last_execution_at: "2026-03-11T18:00:00.000Z",
    }));

    await statsKV(env).put("search-attribution:1", JSON.stringify({
      attribution_id: "1",
      event_type: "search_impression",
      intent: "Find jobs",
      domain: "example.com",
      created_at: "2026-03-12T10:00:00.000Z",
      event_value: 0,
      k: 1,
      results_count: 1,
      contributions: [],
    }));
    await statsKV(env).put("search-attribution:2", JSON.stringify({
      attribution_id: "2",
      event_type: "search_impression",
      intent: "  find   jobs ",
      domain: "example.com",
      created_at: "2026-03-12T12:00:00.000Z",
      event_value: 0,
      k: 1,
      results_count: 1,
      contributions: [],
    }));
    await statsKV(env).put("search-attribution:3", JSON.stringify({
      attribution_id: "3",
      event_type: "search_impression",
      intent: "read front page",
      domain: "news.ycombinator.com",
      created_at: "2026-03-11T12:00:00.000Z",
      event_value: 0,
      k: 1,
      results_count: 1,
      contributions: [],
    }));

    await statsKV(env).put("download-attribution:1", JSON.stringify({
      attribution_id: "download-1",
      event_type: "skill_download",
      skill_id: "skill-example",
      domain: "example.com",
      created_at: "2026-03-12T12:01:00.000Z",
      event_value: 0.01,
      endpoint_id: "skill-example-ep",
      endpoints_considered: 1,
      contributions: [],
    }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns top domains and normalized task intents", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/analytics/usage?limit=5"), env, {
      waitUntil(_promise: Promise<unknown>) {},
      passThroughOnException() {},
    } as ExecutionContext);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      totals: { searches: number; installs: number; executions: number; domains: number; tasks: number };
      top_domains: Array<{ domain: string; searches: number; installs: number; executions: number; skills: number; last_execution_at: string | null }>;
      top_tasks: Array<{ intent: string; searches: number; domains: string[]; last_seen_at: string }>;
      use_cases: Array<{ use_case: string; searches: number; domains: string[]; sample_intents: string[]; last_seen_at: string }>;
      recent_queries: Array<{ intent: string; normalized_intent: string; domain?: string; created_at: string }>;
    };

    expect(body.totals.searches).toBe(3);
    expect(body.totals.installs).toBe(1);
    expect(body.totals.executions).toBe(12);
    expect(body.totals.domains).toBe(2);
    expect(body.totals.tasks).toBe(2);

    expect(body.top_domains[0]).toMatchObject({
      domain: "example.com",
      searches: 2,
      installs: 1,
      executions: 9,
      skills: 1,
      last_execution_at: "2026-03-12T18:00:00.000Z",
    });
    expect(body.top_domains[1]).toMatchObject({
      domain: "news.ycombinator.com",
      searches: 1,
      installs: 0,
      executions: 3,
      skills: 1,
    });

    expect(body.top_tasks[0]).toMatchObject({
      intent: "find jobs",
      searches: 2,
      domains: ["example.com"],
      last_seen_at: "2026-03-12T12:00:00.000Z",
    });
    expect(body.top_tasks[1]).toMatchObject({
      intent: "read front page",
      searches: 1,
      domains: ["news.ycombinator.com"],
    });

    expect(body.use_cases[0]).toMatchObject({
      use_case: "jobs & hiring",
      searches: 2,
      domains: ["example.com"],
      sample_intents: ["find jobs"],
      last_seen_at: "2026-03-12T12:00:00.000Z",
    });
    expect(body.use_cases[1]).toMatchObject({
      use_case: "news & content",
      searches: 1,
      domains: ["news.ycombinator.com"],
      sample_intents: ["read front page"],
    });

    expect(body.recent_queries).toEqual([
      {
        intent: "find jobs",
        normalized_intent: "find jobs",
        domain: "example.com",
        created_at: "2026-03-12T12:00:00.000Z",
      },
      {
        intent: "Find jobs",
        normalized_intent: "find jobs",
        domain: "example.com",
        created_at: "2026-03-12T10:00:00.000Z",
      },
      {
        intent: "read front page",
        normalized_intent: "read front page",
        domain: "news.ycombinator.com",
        created_at: "2026-03-11T12:00:00.000Z",
      },
    ]);
  });
});
