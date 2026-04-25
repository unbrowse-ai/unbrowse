import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { publicSkillRoutes } from "../src/routes/skills.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import type { EndpointStats, Env, SkillManifest } from "../src/types.js";

const BASE_ENV: Env = {
  API_KEY: "test-api-key",
  EMERGENTDB_API_KEY: "test-emergent",
  NEBIUS_API_KEY: "test-nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
};

function skillFixture(skill_id: string, lifecycle: SkillManifest["lifecycle"] = "active"): SkillManifest {
  return {
    skill_id,
    version: "1.0.0",
    schema_version: "1",
    name: `${skill_id}.example.com`,
    intent_signature: `${skill_id}.example.com`,
    domain: `${skill_id}.example.com`,
    description: `Skill ${skill_id}`,
    owner_type: "marketplace",
    execution_type: "http",
    endpoints: [
      {
        endpoint_id: `${skill_id}-ep-a`,
        method: "GET",
        url_template: `https://${skill_id}.example.com/a`,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
      {
        endpoint_id: `${skill_id}-ep-b`,
        method: "GET",
        url_template: `https://${skill_id}.example.com/b`,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
      },
    ],
    lifecycle,
    created_at: "2026-04-03T00:00:00.000Z",
    updated_at: "2026-04-03T00:00:00.000Z",
  };
}

function statsFixture(total_executions: number, successful_executions: number, last_execution_at: string): EndpointStats {
  return {
    total_executions,
    successful_executions,
    consecutive_failures: 0,
    avg_latency_ms: 120,
    feedback_sum: 0,
    feedback_count: 0,
    drift_count: 0,
    last_execution_at,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("popular skill route", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearKVCacheForTests();
    const alpha = skillFixture("alpha");
    const beta = skillFixture("beta");
    const deprecated = skillFixture("legacy", "deprecated");

    const stores = new Map<string, string>([
      ["skills:_idx:main", JSON.stringify([
        { k: "skill:alpha", v: JSON.stringify(alpha) },
        { k: "skill:beta", v: JSON.stringify(beta) },
        { k: "skill:legacy", v: JSON.stringify(deprecated) },
      ])],
      ["skills:_idx:large", JSON.stringify([])],
      ["skills:_idx", JSON.stringify([])],
      ["stats:_idx:main", JSON.stringify([
        { k: "stats:alpha--alpha-ep-a", v: JSON.stringify(statsFixture(12, 11, "2026-04-03T10:00:00.000Z")) },
        { k: "stats:alpha--alpha-ep-b", v: JSON.stringify(statsFixture(8, 7, "2026-04-03T11:00:00.000Z")) },
        { k: "stats:beta--beta-ep-a", v: JSON.stringify(statsFixture(5, 5, "2026-04-03T09:00:00.000Z")) },
        { k: "stats:beta--beta-ep-b", v: JSON.stringify(statsFixture(1, 1, "2026-04-03T08:00:00.000Z")) },
        { k: "stats:legacy--legacy-ep-a", v: JSON.stringify(statsFixture(99, 99, "2026-04-03T12:00:00.000Z")) },
      ])],
      ["stats:_idx:large", JSON.stringify([])],
      ["stats:_idx", JSON.stringify([])],
    ]);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname !== "api.emergentdb.com") throw new Error(`unexpected fetch: ${url.toString()}`);
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = stores.get(key);
        return jsonResponse(value == null ? { found: false, value: null } : { found: true, value });
      }
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    clearKVCacheForTests();
    globalThis.fetch = originalFetch;
  });

  it("returns active skills sorted by executions", async () => {
    const res = await publicSkillRoutes.request("http://localhost/skills/popular?limit=2", {}, BASE_ENV);
    const body = await res.json() as { skills: Array<{ skill_id: string; total_executions: number; successful_executions: number }> };

    expect(res.status).toBe(200);
    expect(body.skills).toHaveLength(2);
    expect(body.skills.map((skill) => skill.skill_id)).toEqual(["alpha", "beta"]);
    expect(body.skills[0]).toMatchObject({ total_executions: 20, successful_executions: 18 });
    expect(body.skills[1]).toMatchObject({ total_executions: 6, successful_executions: 6 });
  });
});
