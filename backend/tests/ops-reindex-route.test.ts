// POST /v1/ops/reindex — admin route that walks active skills and rebuilds
// their vector index. Adds dry_run support (contract 311771e1).
//
// We mock only the external EmergentDB fetch surface; the unit under test —
// the Hono route + listSkills + reindexSkill orchestration — runs real.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import { clearKVCacheForTests, skillsKV } from "../src/services/kv.js";
import type { Env, SkillManifest } from "../src/types.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  // Benign in-memory STATS_KV: indexEndpoints() writes its BM25 lexical index
  // directly via env.STATS_KV (not the KV service). Under local-dev the KV
  // service ignores STATS_KV entirely, so this stub never triggers FallbackKV.
  STATS_KV: {
    put: async () => {},
    get: async () => null,
  } as unknown as KVNamespace,
  ENVIRONMENT: "local-dev",
};

function makeSkill(id: string, domain: string): SkillManifest {
  const now = "2026-05-23T00:00:00.000Z";
  return {
    skill_id: id,
    version: "1.0.0",
    schema_version: "1",
    name: domain,
    intent_signature: domain,
    domain,
    description: `fixture for ${domain}`,
    owner_type: "marketplace",
    execution_type: "http",
    lifecycle: "active",
    created_at: now,
    updated_at: now,
    endpoints: [{
      endpoint_id: `${id}-ep-1`,
      method: "GET",
      url_template: `https://${domain}/api/items`,
      description: "list items",
      idempotency: "safe",
      verification_status: "unverified",
      reliability_score: 0.6,
      graph_visibility: "public",
    }],
    base_price_usd: 0.001,
    trust: {
      graph_visibility: "public",
      promotion_reason: "trusted_system_publisher",
      submission_count: 1,
      unique_submitters: 1,
      verified_release_submissions: 0,
      unique_verified_submitters: 0,
      verified_ratio: 0,
      last_submission_at: now,
    },
  } as unknown as SkillManifest;
}

describe("POST /v1/ops/reindex (contract 311771e1)", () => {
  const originalFetch = globalThis.fetch;
  let store: Map<string, string>;
  let batchInsertHits: Array<{ domain: string; itemCount: number }>;

  beforeEach(async () => {
    clearKVCacheForTests();
    store = new Map();
    batchInsertHits = [];

    // Seed two active skills into the in-memory LocalKV (local-dev) under the
    // same skillsKV(env) instance the reindex route reads via listSkills().
    // LocalKV keys are bare "skill:<id>" (the namespace is the Map identity).
    const skillA = makeSkill("skill-a", "alpha.example.com");
    const skillB = makeSkill("skill-b", "beta.example.com");
    const kv = skillsKV(env);
    await kv.put("skill:skill-a", JSON.stringify(skillA));
    await kv.put("skill:skill-b", JSON.stringify(skillB));

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
        const payload = JSON.parse(String(init?.body ?? "{}")) as { domain?: string; items?: unknown[] };
        batchInsertHits.push({ domain: payload.domain ?? "", itemCount: payload.items?.length ?? 0 });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/graph/delete") return Response.json({ ok: true });
      if (url.pathname === "/graph/edges" || url.pathname === "/graph/search") {
        return Response.json({ ok: true, results: [] });
      }
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("walks active skills, invokes reindex per row, returns per-skill results", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/ops/reindex", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ limit: 10, offset: 0 }),
    }), env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      total_active: number;
      processed: number;
      succeeded: number;
      failed: number;
      results: Array<{ skill_id: string; ok: boolean }>;
    };
    expect(body.total_active).toBe(2);
    expect(body.processed).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.results.map((r) => r.skill_id).sort()).toEqual(["skill-a", "skill-b"]);

    // reindexSkill -> indexEndpoints fires /graph/batch_insert twice per skill
    // (domain namespace + global namespace), so 4 calls for 2 skills.
    expect(batchInsertHits.length).toBeGreaterThanOrEqual(4);
  });

  it("dry_run=1 returns the projection without writing to /graph/batch_insert", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/ops/reindex?dry_run=1", {
      method: "POST",
      headers: {
        Authorization: "Bearer admin",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ limit: 10, offset: 0 }),
    }), env);

    expect(res.status).toBe(200);
    const body = await res.json() as {
      dry_run: boolean;
      total_active: number;
      projected: Array<{ skill_id: string; domain: string }>;
    };
    expect(body.dry_run).toBe(true);
    expect(body.total_active).toBe(2);
    expect(body.projected.length).toBe(2);
    expect(body.projected.map((p) => p.skill_id).sort()).toEqual(["skill-a", "skill-b"]);

    // No batch_insert hits in dry_run mode.
    expect(batchInsertHits.length).toBe(0);
  });

  it("requires admin auth — returns 401 without a bearer", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/ops/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 10 }),
    }), env);
    // bearerAuth returns 401 unauthorized when no bearer is present.
    expect([401, 403]).toContain(res.status);
  });
});
