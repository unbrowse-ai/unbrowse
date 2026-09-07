import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {
    put: async () => {},
    get: async () => null,
  } as unknown as KVNamespace,
  ENVIRONMENT: "staging",
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

    if (url.pathname === "/graph/batch_insert") {
      return Response.json({
        error: "Insufficient graph credits",
        balance_micro: 0,
        cost_micro: 180,
      }, { status: 402 });
    }

    if (url.pathname === "/graph/edges") {
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

function publishPayload(domain: string): SkillManifest {
  return {
    skill_id: `skill-${domain}`,
    version: "1.0.0",
    schema_version: "1",
    name: domain,
    intent_signature: domain,
    domain,
    description: "fixture",
    owner_type: "marketplace",
    execution_type: "http",
    lifecycle: "active",
    base_price_usd: 0.002,
    created_at: "2026-04-02T00:00:00.000Z",
    updated_at: "2026-04-02T00:00:00.000Z",
    endpoints: [{
      endpoint_id: "ep-1",
      method: "GET",
      url_template: `https://${domain}/api/search`,
      description: "fixture endpoint",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.95,
    }],
  };
}

describe("graph credit degradation", () => {
  const originalFetch = globalThis.fetch;
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    globalThis.fetch = createMockFetch(store) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("publishes the skill and reports graph_credits_required when indexing is unpaid", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(publishPayload("graph-credit-required.example.com")),
    }), env);

    expect(res.status).toBe(201);
    const body = await res.json() as SkillManifest & { index_status: string };
    expect(body.index_status).toBe("graph_credits_required");
    expect(body.skill_id).toBe("skill-graph-credit-required.example.com");
  });
});
