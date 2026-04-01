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

  // The /v1/analytics/usage endpoint and its backing service (getUsageSummary)
  // have not been implemented yet. The test documents the expected aggregation
  // of skill execution stats + search attribution into domain/task breakdowns.
  it.todo("returns top domains and normalized task intents — analytics/usage endpoint and service not implemented");
});
