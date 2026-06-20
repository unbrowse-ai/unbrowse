import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env, SkillManifest } from "../src/types.js";
import { skillsKV, statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {
    put: async () => {},
    get: async () => null,
  } as unknown as KVNamespace,
  ENVIRONMENT: "staging",
  REQUIRE_DOMAIN_VERIFICATION: "0",
  RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
};

function signedReleaseHeaders() {
  const manifest = JSON.stringify({
    schema_version: 1,
    release_version: "2.11.0",
    git_sha: "git-a",
    code_hash: "code-a",
    trace_version: "trace-a",
    issued_at: "2026-04-02T00:00:00.000Z",
  });
  const signature = createHmac("sha256", env.RELEASE_MANIFEST_SIGNING_SECRET!)
    .update(manifest)
    .digest("base64url");
  return {
    "X-Unbrowse-Release-Manifest": Buffer.from(manifest, "utf8").toString("base64url"),
    "X-Unbrowse-Release-Signature": signature,
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

    if (url.pathname === "/qdkv/mget") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { keys?: string[] };
      const values: Record<string, string | null> = {};
      for (const key of body.keys ?? []) values[key] = store.get(key) ?? null;
      return Response.json({ values });
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

    if (url.pathname.startsWith("/graph/")) {
      if (url.pathname === "/graph/search") {
        return Response.json({ results: [] });
      }
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

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

describe("protected route auth", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("gates unauthenticated unsigned skill publish (426 client_update_required)", async () => {
    // STALE-TEST CORRECTION (was: expected 401 "Missing or invalid Authorization
    // header"). Commit dc831c06 ("feat(auth): bearer optional on contribution
    // routes — publish always, attribute wallet-less to global index")
    // deliberately switched POST /v1/skills from `bearerAuth` to
    // `indexContributorAuth`: publish no longer hard-requires a bearer key — an
    // anonymous request is attributed to the global-index wallet so the index
    // always grows. The remaining gate for an unauthenticated, unsigned client is
    // `requireSignedClient`, which 426s when no signed release manifest is present.
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(publishPayload("auth-required.example.com")),
    }), env);

    expect(res.status).toBe(426);
    expect(await res.json()).toEqual(expect.objectContaining({
      error: "client_update_required",
    }));
  });

  it("persists contributor payout metadata on authenticated publish", async () => {
    const token = "alpha123456";
    const walletAddress = "So1anaWallet11111111111111111111111111111111";

    const walletRes = await app.fetch(new Request("http://local.test/v1/agents/wallet", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        wallet_address: walletAddress,
        wallet_provider: "lobster.cash",
      }),
    }), env);
    expect(walletRes.status).toBe(200);

    const publishRes = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload("auth-publish.example.com")),
    }), env);

    expect(publishRes.status).toBe(201);
    const body = await publishRes.json() as SkillManifest & { warnings?: string[] };
    expect(body.contributors).toEqual([
      expect.objectContaining({
        agent_id: "staging_alpha123",
        wallet_address: walletAddress,
        share: 90,
      }),
    ]);
    expect(body.split_config).toBe(walletAddress);

    const stored = await skillsKV(env).get(`skill:${body.skill_id}`, "json") as SkillManifest | null;
    expect(stored?.contributors).toEqual([
      expect.objectContaining({
        agent_id: "staging_alpha123",
        wallet_address: walletAddress,
        share: 90,
      }),
    ]);
    expect(stored?.split_config).toBe(walletAddress);

    const profile = await statsKV(env).get("agent:staging_alpha123", "json") as { wallet_address?: string } | null;
    expect(profile?.wallet_address).toBe(walletAddress);
  });

  it("rejects unauthenticated execution stats writes", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/stats/execution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skill_id: "skill-1",
        endpoint_id: "ep-1",
        trace: {
          trace_id: "trace-1",
          skill_id: "skill-1",
          endpoint_id: "ep-1",
          started_at: "2026-04-02T00:00:00.000Z",
          completed_at: "2026-04-02T00:00:01.000Z",
          success: true,
        },
      }),
    }), env);

    expect(res.status).toBe(401);
  });
});
