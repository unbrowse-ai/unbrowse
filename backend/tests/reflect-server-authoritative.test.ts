// Regression: reliability + staleness are CROSS-USER aggregates and must be
// computed server-side. The old client path PATCHed a single-client guess
// over the marketplace aggregate. This pins the server-authoritative contract:
// POST /v1/stats/reflect records the outcome observation, the server applies
// the Bayesian-smoothed aggregate + auto-deprecation gate, and returns the
// recomputed authoritative reliability the client must adopt.
//
// No-mock: the real Hono app + the real scoring.ts service code run. Only the
// external EmergentDB KV transport is an in-memory backing store (identical
// pattern to skills-trust-promotion.test.ts / churn-curve.test.ts).
import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import type { Env, SkillManifest } from "../src/types.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  // Benign in-memory STATS_KV for any direct env.STATS_KV writers. Under
  // local-dev the KV service uses in-memory LocalKV and never touches this.
  STATS_KV: {
    put: async () => {},
    get: async () => null,
  } as unknown as KVNamespace,
  ENVIRONMENT: "local-dev",
  REQUIRE_DOMAIN_VERIFICATION: "0",
  RELEASE_MANIFEST_SIGNING_SECRET: "release-secret",
};

function publishPayload(domain: string, endpointOverrides?: Partial<SkillManifest["endpoints"][number]>) {
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
      ...endpointOverrides,
    }],
  };
}

function signedReleaseHeaders() {
  const manifest = JSON.stringify({
    schema_version: 1,
    release_version: "2.11.0",
    git_sha: "git-a",
    code_hash: "code-a",
    trace_version: "trace-a",
    issued_at: "2026-04-04T00:00:00.000Z",
  });
  const signature = createHmac("sha256", env.RELEASE_MANIFEST_SIGNING_SECRET!)
    .update(manifest)
    .digest("base64url");
  return {
    "X-Unbrowse-Trace-Version": "trace-a",
    "X-Unbrowse-Code-Hash": "code-a",
    "X-Unbrowse-Git-Sha": "git-a",
    "X-Unbrowse-Release-Manifest": Buffer.from(manifest, "utf8").toString("base64url"),
    "X-Unbrowse-Release-Signature": signature,
  };
}

interface ReliabilityShape {
  reliability_score: number;
  verification_status: string;
  stale: boolean;
  total_observations: number;
  auto_deprecated_at?: string;
}

describe("reflect → server-authoritative reliability", () => {
  const originalFetch = globalThis.fetch;
  let store: Map<string, string>;

  beforeEach(() => {
    clearKVCacheForTests();
    store = new Map();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      // ai-scrub fires a Nebius chat call on publish. Return a valid no-leak
      // verdict so the scrub path completes cleanly instead of soft-failing.
      if (url.hostname === "api.tokenfactory.nebius.com") {
        if (url.pathname === "/v1/chat/completions") {
          return Response.json({ choices: [{ message: { content: JSON.stringify({ leaks: [] }) } }] });
        }
        if (url.pathname === "/v1/embeddings") {
          return Response.json({ data: [{ embedding: new Array(8).fill(0) }] });
        }
        return Response.json({ choices: [{ message: { content: "{}" } }] });
      }
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
      if (url.pathname === "/graph/batch_insert" || url.pathname === "/graph/delete" ||
          url.pathname === "/graph/edges" || url.pathname === "/graph/search") {
        return Response.json({ ok: true, results: [] });
      }
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function publish(domain: string): Promise<string> {
    const res = await app.fetch(new Request("http://local.test/v1/skills", {
      method: "POST",
      headers: {
        // local-dev: verifyKey no longer blanket-accepts any bearer (that was
        // staging-only), so authenticate as the env API_KEY admin to publish
        // the fixture. The reflect/feedback assertions don't depend on the
        // publisher's agent identity.
        Authorization: "Bearer admin",
        "Content-Type": "application/json",
        ...signedReleaseHeaders(),
      },
      body: JSON.stringify(publishPayload(domain)),
    }), env);
    expect(res.status).toBe(201);
    return `skill-${domain}`;
  }

  async function reflect(skillId: string, intentStatus: string): Promise<{ status: number; body: { ok?: boolean; reliability?: ReliabilityShape; error?: string } }> {
    const res = await app.fetch(new Request("http://local.test/v1/stats/reflect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_id: skillId, endpoint_id: "ep-1", intent_status: intentStatus }),
    }), env);
    return { status: res.status, body: await res.json() as { ok?: boolean; reliability?: ReliabilityShape; error?: string } };
  }

  it("records a reflect outcome server-side and returns the authoritative reliability", async () => {
    const skillId = await publish("reflect-ok.example.com");
    const { status, body } = await reflect(skillId, "achieved");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.reliability).toBeDefined();
    const r = body.reliability!;
    expect(typeof r.reliability_score).toBe("number");
    expect(r.reliability_score).toBeGreaterThanOrEqual(0);
    expect(r.reliability_score).toBeLessThanOrEqual(1);
    expect(typeof r.verification_status).toBe("string");
    expect(typeof r.stale).toBe("boolean");
    // One execution + one feedback observation recorded server-side.
    expect(r.total_observations).toBeGreaterThanOrEqual(1);
  });

  it("the server aggregate is persisted + recomputed across reflect calls (resolve evidence)", async () => {
    const skillId = await publish("reflect-persist.example.com");
    const first = await reflect(skillId, "achieved");
    const second = await reflect(skillId, "achieved");
    // Each reflect is a fresh population observation; the count strictly grows,
    // proving the aggregate is persisted server-side, not recomputed from a
    // stateless client guess.
    expect(second.body.reliability!.total_observations)
      .toBeGreaterThan(first.body.reliability!.total_observations);
    // Two achieved executions => 100% success ratio => score climbs above the
    // 0.55 seed. The value is the server aggregate, not a client Bayesian step.
    expect(second.body.reliability!.reliability_score).toBeGreaterThan(0.55);
    expect(second.body.reliability!.stale).toBe(false);
  });

  it("sustained failures drive the server aggregate down and flip stale via the deprecation floor", async () => {
    const skillId = await publish("reflect-decay.example.com");
    let last: ReliabilityShape | undefined;
    for (let i = 0; i < 12; i++) {
      const { body } = await reflect(skillId, "failed");
      last = body.reliability;
    }
    expect(last).toBeDefined();
    // Population aggregate (computeReliabilityScore over EndpointStats), not a
    // single-client Bayesian step, drives this below the 0.2 deprecation floor.
    expect(last!.reliability_score).toBeLessThan(0.2);
    expect(last!.stale).toBe(true);
  });

  it("rejects unknown skill/endpoint and malformed intent_status", async () => {
    const missing = await reflect("skill-does-not-exist", "achieved");
    expect(missing.status).toBe(404);
    const skillId = await publish("reflect-validate.example.com");
    const bad = await app.fetch(new Request("http://local.test/v1/stats/reflect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_id: skillId, endpoint_id: "ep-1", intent_status: "great" }),
    }), env);
    expect(bad.status).toBe(400);
  });

  it("feedback route also surfaces the recomputed server-authoritative reliability", async () => {
    const skillId = await publish("reflect-feedback.example.com");
    const res = await app.fetch(new Request("http://local.test/v1/stats/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_id: skillId, endpoint_id: "ep-1", rating: 5 }),
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; avg_rating: number; reliability?: ReliabilityShape };
    expect(body.ok).toBe(true);
    expect(typeof body.avg_rating).toBe("number");
    expect(body.reliability).toBeDefined();
    expect(typeof body.reliability!.reliability_score).toBe("number");
  });
});
