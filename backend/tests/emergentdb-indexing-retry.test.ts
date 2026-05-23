// BUG-007 (contract 311771e1): silent indexing failures must log + write a
// `needs_reindex:<skill_id>` flag so the reindex sweep can heal the gap.
// We mock only the external EmergentDB HTTP surface (fetch); the unit under
// test — publishSkill via POST /v1/skills — runs real (contract 4305eae2).

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
  RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
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
    created_at: "2026-05-23T00:00:00.000Z",
    updated_at: "2026-05-23T00:00:00.000Z",
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

describe("BUG-007: silent indexing failures (contract 311771e1)", () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  let store: Map<string, string>;
  let errorLogs: string[];

  beforeEach(() => {
    store = new Map();
    errorLogs = [];
    // Capture console.error so we can assert the failure was logged.
    console.error = ((...args: unknown[]) => {
      errorLogs.push(args.map((a) => String(a)).join(" "));
    }) as typeof console.error;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (url.hostname !== "api.emergentdb.com") {
        throw new Error(`Unexpected fetch: ${url.toString()}`);
      }
      // KV ops on stats/skills succeed normally — we need the manifest to land.
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
      // Indexing fails: this is what we're testing.
      if (url.pathname === "/graph/batch_insert") {
        return new Response(JSON.stringify({ error: "simulated emergentdb outage" }), { status: 503 });
      }
      if (url.pathname === "/graph/delete") {
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
    console.error = originalConsoleError;
  });

  it("logs a [indexEndpoints] failed line + writes needs_reindex:<id> on indexing error", async () => {
    const domain = "indexing-fail.example.com";
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin", // admin bypass — promotes endpoints to public so indexEndpoints actually runs
        "Content-Type": "application/json",
      },
      body: JSON.stringify(publishPayload(domain)),
    }), env);

    // Publish should still succeed — the skill manifest is durable; indexing
    // is the soft signal we flag for re-run.
    if (res.status !== 201) {
      const t = await res.clone().text();
      throw new Error(`expected 201 got ${res.status}: ${t}`);
    }
    expect(res.status).toBe(201);
    const body = await res.json() as SkillManifest & { index_status?: string };
    expect(body.skill_id).toBeDefined();

    // (a) error was logged. Some logs may go to console.error via different
    // wrappers; collect what we captured for diagnosis if the assertion fails.
    const indexLogs = errorLogs.filter((line) => line.includes("[indexEndpoints] failed"));
    if (indexLogs.length === 0) {
      throw new Error(`No [indexEndpoints] error logged. All captured logs (${errorLogs.length}): ${JSON.stringify(errorLogs.slice(0, 20))}`);
    }
    expect(indexLogs.length).toBeGreaterThanOrEqual(1);
    expect(indexLogs[0]).toContain(body.skill_id);

    // (b) needs_reindex:<id> row written to statsKV (real key shape:
    // "<env>-stats:needs_reindex:<skill_id>"). The stats KV namespace prefix
    // is environment-specific; we just find by suffix.
    const flagKey = [...store.keys()].find((k) => k.endsWith(`:needs_reindex:${body.skill_id}`));
    expect(flagKey).toBeDefined();
    const flagPayload = JSON.parse(store.get(flagKey!) ?? "{}") as {
      ts?: number;
      phase?: string;
      err?: string;
    };
    expect(flagPayload.phase).toBe("index_endpoints");
    expect(flagPayload.err).toBeDefined();
    expect(typeof flagPayload.ts).toBe("number");
  });
});
