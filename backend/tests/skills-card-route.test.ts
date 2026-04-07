import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import { skillsKV } from "../src/services/kv.js";
import type { Env, SkillManifest } from "../src/types.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
};

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

function makeSkill(overrides: Partial<SkillManifest> & Pick<SkillManifest, "skill_id" | "domain" | "updated_at">): SkillManifest {
  return {
    skill_id: overrides.skill_id,
    version: "1.0.0",
    schema_version: "1",
    name: overrides.domain,
    intent_signature: `${overrides.domain} search`,
    domain: overrides.domain,
    description: `Skill for ${overrides.domain}`,
    owner_type: "marketplace",
    execution_type: "http",
    endpoints: [
      {
        endpoint_id: `${overrides.skill_id}-get`,
        method: "GET",
        url_template: `https://${overrides.domain}/api/items`,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
        response_schema: {
          type: "object",
          inferred_from_samples: 1,
          properties: { payload: { type: "string", inferred_from_samples: 1 } },
        },
      },
      {
        endpoint_id: `${overrides.skill_id}-post`,
        method: "POST",
        url_template: `https://${overrides.domain}/api/items`,
        idempotency: "unsafe",
        verification_status: "pending",
        reliability_score: 0.5,
      },
    ],
    lifecycle: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at,
    ...overrides,
  };
}

describe("skills card route", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await (skillsKV(env) as any).resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns a compact, cacheable skill card list", async () => {
    const kv = skillsKV(env);
    await kv.put("skill:skill-older", JSON.stringify(makeSkill({
      skill_id: "skill-older",
      domain: "older.example",
      updated_at: "2026-04-01T00:00:00.000Z",
    })));
    await kv.put("skill:skill-newer", JSON.stringify(makeSkill({
      skill_id: "skill-newer",
      domain: "newer.example",
      updated_at: "2026-04-02T00:00:00.000Z",
    })));

    const res = await app.fetch(new Request("http://local.test/v1/skills?view=card&limit=1", { headers: { Authorization: "Bearer admin" } }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=300");

    const body = await res.json() as {
      skills: Array<{
        skill_id: string;
        endpoint_count: number;
        avg_reliability_score: number;
        endpoints: Array<Record<string, unknown>>;
      }>;
    };

    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]?.skill_id).toBe("skill-newer");
    expect(body.skills[0]?.endpoint_count).toBe(2);
    expect(body.skills[0]?.avg_reliability_score).toBeCloseTo(0.7, 5);
    expect(body.skills[0]?.endpoints[0]?.url_template).toBeUndefined();
    expect(body.skills[0]?.endpoints[0]?.response_schema).toBeUndefined();

    store.delete("skills:skill:skill-older");
    store.delete("skills:skill:skill-newer");

    const cachedRes = await app.fetch(new Request("http://local.test/v1/skills?view=card", { headers: { Authorization: "Bearer admin" } }), env);
    expect(cachedRes.status).toBe(200);
    const cachedBody = await cachedRes.json() as { skills: Array<{ skill_id: string }> };
    expect(cachedBody.skills.map((skill) => skill.skill_id)).toEqual(["skill-newer", "skill-older"]);
  });
});
