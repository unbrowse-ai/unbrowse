import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";

const env: Env = {
  API_KEY: "admin",
  UNKEY_ROOT_KEY: "root",
  UNKEY_API_ID: "api",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {
    put: async () => {},
    get: async () => null,
  } as unknown as KVNamespace,
  ENVIRONMENT: "staging",
};

function publishPayload(domain: string) {
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
    created_at: "2026-04-04T00:00:00.000Z",
    updated_at: "2026-04-04T00:00:00.000Z",
    endpoints: [{
      endpoint_id: "ep-1",
      method: "GET",
      url_template: `https://${domain}/api/search`,
      description: "fixture endpoint",
      idempotency: "safe",
      verification_status: "unverified",
      reliability_score: 0.55,
    }],
  };
}

describe("skills trust promotion", () => {
  const originalFetch = globalThis.fetch;
  let graphInsertCalls: Array<{ domain: string; ids: string[] }>;
  let graphDeleteCalls: Array<{ domain: string; id?: string }>;
  let store: Map<string, string>;

  beforeEach(() => {
    graphInsertCalls = [];
    graphDeleteCalls = [];
    store = new Map();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
        const body = JSON.parse(String(init?.body ?? "{}")) as { domain: string; items: Array<{ id: string }> };
        graphInsertCalls.push({ domain: body.domain, ids: body.items.map((item) => item.id) });
        return Response.json({ ok: true });
      }

      if (url.pathname === "/graph/delete") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { domain: string; id?: string };
        graphDeleteCalls.push(body);
        return Response.json({ ok: true });
      }

      if (url.pathname === "/graph/edges" || url.pathname === "/graph/search") {
        return Response.json({ ok: true, results: [] });
      }

      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("keeps first unverified publish in shadow and out of the graph", async () => {
    const domain = "shadow-only.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
        "X-Unbrowse-Trace-Version": "trace-a",
        "X-Unbrowse-Code-Hash": "code-a",
        "X-Unbrowse-Git-Sha": "git-a",
      },
      body: JSON.stringify(publishPayload(domain)),
    }), env);

    expect(res.status).toBe(201);
    const body = await res.json() as SkillManifest & { index_status: string };
    expect(body.index_status).toContain("shadow:");
    expect(body.trust).toEqual(expect.objectContaining({
      graph_visibility: "shadow",
      unique_submitters: 1,
      submission_count: 1,
    }));
    expect(body.endpoints[0]?.graph_visibility).toBe("shadow");
    expect(body.provenance_events?.[0]).toEqual(expect.objectContaining({
      submitter_agent_id: "staging_alpha123",
      client_trace_version: "trace-a",
      client_code_hash: "code-a",
      client_git_sha: "git-a",
    }));
    expect(graphInsertCalls).toHaveLength(0);
    expect(graphDeleteCalls).toHaveLength(0);
  });

  it("promotes a skill to public graph visibility after a second distinct submitter", async () => {
    const domain = "promoted.example.com";
    const first = publishPayload(domain);
    const second = publishPayload(domain);
    second.endpoints = [{
      ...second.endpoints[0],
      endpoint_id: "ep-2",
      url_template: `https://${domain}/api/details`,
      description: "details endpoint",
    }];

    const firstRes = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(first),
    }), env);
    expect(firstRes.status).toBe(201);

    const secondRes = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer beta123456",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(second),
    }), env);
    expect(secondRes.status).toBe(201);

    const body = await secondRes.json() as SkillManifest & { index_status: string };
    expect(body.trust).toEqual(expect.objectContaining({
      graph_visibility: "public",
      promotion_reason: "multi_submitter",
      unique_submitters: 2,
      submission_count: 2,
    }));
    expect(body.endpoints.every((endpoint) => endpoint.graph_visibility === "public")).toBe(true);
    expect(graphInsertCalls.length).toBeGreaterThan(0);
    expect(graphInsertCalls.some((call) => call.ids.some((id) => id.includes(":ep-1")))).toBe(true);
    expect(graphInsertCalls.some((call) => call.ids.some((id) => id.includes(":ep-2")))).toBe(true);
  });
});
