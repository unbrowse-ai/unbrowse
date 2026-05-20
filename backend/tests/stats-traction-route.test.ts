/**
 * Route-level integration test for GET /v1/stats/traction.
 *
 * Mounts publicStatsRoutes on a Hono app and drives the real handler end-to-
 * end. KV is the in-process LocalKV backend (ENVIRONMENT="local-dev"), so we
 * seed shape via statsKV(env).put(...) without mocking analytics or metrics
 * at the module level (which would bleed across the bun:test run, per the
 * storm-safe extraction lesson).
 *
 * External network calls inside getTractionMetrics (github / npm /
 * cloudflare) are intercepted by a globalThis.fetch shim so the suite never
 * touches the public internet. The Cloudflare path is gated on env tokens,
 * so leaving them unset exercises the source:"unconfigured" branch without
 * needing to touch fetch for that lane at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { publicStatsRoutes } from "../src/routes/stats.js";
import { clearKVCacheForTests, statsKV } from "../src/services/kv.js";
import type { Env } from "../src/types.js";

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    API_KEY: "test-api-key",
    EMERGENTDB_API_KEY: "test-emergent",
    NEBIUS_API_KEY: "test-nebius",
    STATS_KV: {} as KVNamespace,
    ENVIRONMENT: "local-dev",
    ...extra,
  } as Env;
}

interface TractionResponse {
  totalKeys: number;
  totalVerifications: number;
  wau: number;
  weeklyRetention: number;
  githubStars: number;
  githubForks: number;
  npmDownloadsTotal: number;
  npmDownloadsWeekly: number;
  cloudflare: {
    totalRequests: number;
    uniqueVisitors: number;
    bandwidthGB: number;
    source: string;
  };
  verificationFunnel: {
    totalRegistered: number;
    verified1Plus: number;
    verified10Plus: number;
    verified100Plus: number;
    verified1000Plus: number;
  };
  dau?: Array<{ day: string; active_keys: number }>;
}

function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/v1", publicStatsRoutes);
  return app;
}

/**
 * Stub global fetch so the github/npm calls inside getTractionMetrics never
 * hit the network. Returns 503 for any URL so both helpers fall into their
 * non-ok branch and return zeros. Cloudflare is gated on env tokens, so
 * without CLOUDFLARE_API_TOKEN/CLOUDFLARE_ZONE_ID it never reaches fetch.
 */
function installOfflineFetch(): typeof globalThis.fetch {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname === "api.github.com" || url.hostname === "api.npmjs.org" || url.hostname === "api.cloudflare.com") {
      return new Response("offline", { status: 503 });
    }
    throw new Error(`unexpected fetch in stats-traction-route test: ${url.toString()}`);
  }) as typeof fetch;
  return original;
}

describe("GET /v1/stats/traction", () => {
  let restoreFetch: typeof globalThis.fetch;

  beforeEach(() => {
    clearKVCacheForTests("stats");
    restoreFetch = installOfflineFetch();
  });

  afterEach(() => {
    globalThis.fetch = restoreFetch;
    clearKVCacheForTests("stats");
  });

  it("empty KV returns 200 with a zero-shaped envelope and cloudflare.source === 'unconfigured'", async () => {
    const app = buildApp();
    const res = await app.request("/v1/stats/traction", {}, makeEnv());

    expect(res.status).toBe(200);
    const body = await res.json() as TractionResponse;

    expect(body.totalKeys).toBe(0);
    expect(body.totalVerifications).toBe(0);
    expect(body.wau).toBe(0);
    expect(body.weeklyRetention).toBe(0);

    expect(typeof body.verificationFunnel).toBe("object");
    expect(typeof body.verificationFunnel.totalRegistered).toBe("number");
    expect(typeof body.verificationFunnel.verified1Plus).toBe("number");
    expect(typeof body.verificationFunnel.verified10Plus).toBe("number");
    expect(typeof body.verificationFunnel.verified100Plus).toBe("number");
    expect(typeof body.verificationFunnel.verified1000Plus).toBe("number");

    expect(body.cloudflare.source).toBe("unconfigured");
    expect(body.cloudflare.totalRequests).toBe(0);
    expect(body.cloudflare.uniqueVisitors).toBe(0);
    expect(body.cloudflare.bandwidthGB).toBe(0);

    expect(Array.isArray(body.dau)).toBe(true);
  });

  it("seeded agent + 2-pass stats record yields totalVerifications=2 and verified1Plus=1", async () => {
    const env = makeEnv();

    await statsKV(env).put("agent:agent-zephyra", JSON.stringify({
      agent_id: "agent-zephyra",
      name: "agent-zephyra",
      created_at: "2026-04-01T00:00:00.000Z",
      skills_discovered: [],
      total_executions: 2,
      total_feedback_given: 0,
      tos_accepted_version: "2026-01-01",
      tos_accepted_at: "2026-04-01T00:00:00.000Z",
      activity_dates: [],
    }));

    await statsKV(env).put("stats:skill-octave--ep-primary", JSON.stringify({
      version_history: [
        { version: "1.0.0", status: "pass", verified_at: "2026-05-10T00:00:00Z", agent_id: "agent-zephyra" },
        { version: "1.0.1", status: "pass", verified_at: "2026-05-11T00:00:00Z", agent_id: "agent-zephyra" },
      ],
    }));

    const app = buildApp();
    const res = await app.request("/v1/stats/traction", {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as TractionResponse;

    expect(body.totalVerifications).toBe(2);
    expect(body.verificationFunnel.verified1Plus).toBe(1);
    expect(body.verificationFunnel.verified10Plus).toBe(0);
    expect(body.verificationFunnel.verified100Plus).toBe(0);
    expect(body.verificationFunnel.verified1000Plus).toBe(0);
    expect(body.verificationFunnel.totalRegistered).toBeGreaterThanOrEqual(1);
  });

  it("response always exposes the backwards-compat cloudflare fields totalRequests/uniqueVisitors/bandwidthGB", async () => {
    const app = buildApp();
    const res = await app.request("/v1/stats/traction", {}, makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as TractionResponse;

    expect(body.cloudflare).toBeDefined();
    expect("totalRequests" in body.cloudflare).toBe(true);
    expect("uniqueVisitors" in body.cloudflare).toBe(true);
    expect("bandwidthGB" in body.cloudflare).toBe(true);
    expect(typeof body.cloudflare.totalRequests).toBe("number");
    expect(typeof body.cloudflare.uniqueVisitors).toBe("number");
    expect(typeof body.cloudflare.bandwidthGB).toBe("number");
  });

  it("returns cloudflare.source === 'error' and zeros when the configured Cloudflare GraphQL call fails", async () => {
    const env = makeEnv({
      CLOUDFLARE_API_TOKEN: "fake-token-for-test",
      CLOUDFLARE_ZONE_ID: "fake-zone-for-test",
    });

    const app = buildApp();
    const res = await app.request("/v1/stats/traction", {}, env);
    expect(res.status).toBe(200);
    const body = await res.json() as TractionResponse;

    // installOfflineFetch returns 503 for api.cloudflare.com, so the GraphQL
    // path enters the !res.ok branch and tags source:"error" with zeros.
    expect(body.cloudflare.source).toBe("error");
    expect(body.cloudflare.totalRequests).toBe(0);
    expect(body.cloudflare.uniqueVisitors).toBe(0);
    expect(body.cloudflare.bandwidthGB).toBe(0);
  });
});
