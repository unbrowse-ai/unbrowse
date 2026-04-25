import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { computeBottleneckMetrics, computePercentile, getBottleneckMetrics } from "../src/services/analytics.js";
import { statsKV, skillsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
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

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

describe("computeBottleneckMetrics (pure)", () => {
  it("computes percentiles and rates from raw arrays", () => {
    const metrics = computeBottleneckMetrics(
      [100, 200, 300, 400, 500],   // captures
      [50, 100, 150, 200, 250],     // resolves
      [10, 20, 30, 40, 50],         // executes
      20,   // cacheHits
      30,   // marketplaceHits
      10,   // liveCaptures
      5,    // failures
      100,  // totalRequests
      4,    // uniqueDomains
      12,   // totalSkills
    );

    expect(metrics.capture_latency_p50_ms).toBe(300);
    expect(metrics.capture_latency_p95_ms).toBe(500);
    expect(metrics.resolve_latency_p50_ms).toBe(150);
    expect(metrics.resolve_latency_p95_ms).toBe(250);
    expect(metrics.execute_latency_p50_ms).toBe(30);
    expect(metrics.execute_latency_p95_ms).toBe(50);
    expect(metrics.cache_hit_rate).toBe(0.2);
    expect(metrics.marketplace_hit_rate).toBe(0.3);
    expect(metrics.live_capture_rate).toBe(0.1);
    expect(metrics.failure_rate).toBe(0.05);
    expect(metrics.skills_per_domain).toBe(3);
  });

  it("returns zeros when inputs are empty", () => {
    const metrics = computeBottleneckMetrics([], [], [], 0, 0, 0, 0, 0, 0, 0);

    expect(metrics.capture_latency_p50_ms).toBe(0);
    expect(metrics.capture_latency_p95_ms).toBe(0);
    expect(metrics.cache_hit_rate).toBe(0);
    expect(metrics.failure_rate).toBe(0);
    expect(metrics.skills_per_domain).toBe(0);
  });
});

describe("computePercentile", () => {
  it("returns 0 for empty arrays", () => {
    expect(computePercentile([], 50)).toBe(0);
    expect(computePercentile([], 95)).toBe(0);
  });

  it("computes p50 and p95 for a range of values", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(computePercentile(values, 50)).toBe(50);
    expect(computePercentile(values, 95)).toBe(100);
  });

  it("handles single-element arrays", () => {
    expect(computePercentile([42], 50)).toBe(42);
    expect(computePercentile([42], 95)).toBe(42);
  });
});

describe("getBottleneckMetrics (KV-backed)", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
    await statsKV(env).resetSplitIndex();
    await skillsKV(env).resetSplitIndex();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns zero metrics when no perf data exists", async () => {
    const metrics = await getBottleneckMetrics(env);

    expect(metrics.capture_latency_p50_ms).toBe(0);
    expect(metrics.capture_latency_p95_ms).toBe(0);
    expect(metrics.resolve_latency_p50_ms).toBe(0);
    expect(metrics.resolve_latency_p95_ms).toBe(0);
    expect(metrics.cache_hit_rate).toBe(0);
    expect(metrics.marketplace_hit_rate).toBe(0);
    expect(metrics.failure_rate).toBe(0);
    expect(metrics.skills_per_domain).toBe(0);
  });

  it("computes metrics from seeded perf stats and skill data", async () => {
    // Seed perf stats
    await statsKV(env).put("perf:orchestration", JSON.stringify({
      total_resolves: 100,
      marketplace_hits: 40,
      cache_hits: 30,
      live_captures: 20,
      dom_fallbacks: 5,
      avg_total_ms: 200,
      avg_search_ms: 50,
      avg_execute_ms: 100,
      avg_marketplace_ms: 150,
      avg_cache_ms: 30,
      avg_live_capture_ms: 500,
      p95_total_ms: 800,
      total_tokens_saved: 5000,
      total_response_bytes: 100000,
      avg_time_saved_pct: 60,
      avg_tokens_saved_pct: 40,
      last_updated_at: "2026-03-30T10:00:00.000Z",
    }));

    // Seed recent timing window (used as resolve latency)
    await statsKV(env).put("perf:recent", JSON.stringify(
      [100, 150, 200, 250, 300, 350, 400, 450, 500, 800],
    ));

    // Seed skills
    await skillsKV(env).put("skill:s1", JSON.stringify({
      skill_id: "s1", domain: "example.com", lifecycle: "active",
    }));
    await skillsKV(env).put("skill:s2", JSON.stringify({
      skill_id: "s2", domain: "example.com", lifecycle: "active",
    }));
    await skillsKV(env).put("skill:s3", JSON.stringify({
      skill_id: "s3", domain: "other.com", lifecycle: "active",
    }));
    await skillsKV(env).put("skill:s4", JSON.stringify({
      skill_id: "s4", domain: "other.com", lifecycle: "deprecated",
    }));

    const metrics = await getBottleneckMetrics(env);

    // Resolve latency from perf:recent window
    expect(metrics.resolve_latency_p50_ms).toBeGreaterThan(0);
    expect(metrics.resolve_latency_p95_ms).toBeGreaterThan(0);

    // Hit rates: 30/100 = 0.3 cache, 40/100 = 0.4 marketplace
    expect(metrics.cache_hit_rate).toBe(0.3);
    expect(metrics.marketplace_hit_rate).toBe(0.4);
    expect(metrics.live_capture_rate).toBe(0.2);

    // Failures: 100 - (40+30+20+5) = 5 → 5/100 = 0.05
    expect(metrics.failure_rate).toBe(0.05);

    // 3 active skills across 2 domains → 1.5
    expect(metrics.skills_per_domain).toBe(1.5);
  });

  it("GET /v1/analytics/bottleneck returns 200 with metrics", async () => {
    // Seed minimal perf data
    await statsKV(env).put("perf:orchestration", JSON.stringify({
      total_resolves: 10,
      marketplace_hits: 5,
      cache_hits: 3,
      live_captures: 1,
      dom_fallbacks: 0,
      avg_total_ms: 100,
      avg_search_ms: 20,
      avg_execute_ms: 50,
      avg_marketplace_ms: 80,
      avg_cache_ms: 15,
      avg_live_capture_ms: 400,
      p95_total_ms: 300,
      total_tokens_saved: 500,
      total_response_bytes: 10000,
      avg_time_saved_pct: 50,
      avg_tokens_saved_pct: 30,
      last_updated_at: "2026-03-31T10:00:00.000Z",
    }));

    const res = await app.fetch(new Request("http://local.test/v1/analytics/bottleneck", {
      headers: { Authorization: "Bearer admin" },
    }), env);

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;

    expect(body).toHaveProperty("capture_latency_p50_ms");
    expect(body).toHaveProperty("capture_latency_p95_ms");
    expect(body).toHaveProperty("resolve_latency_p50_ms");
    expect(body).toHaveProperty("resolve_latency_p95_ms");
    expect(body).toHaveProperty("execute_latency_p50_ms");
    expect(body).toHaveProperty("execute_latency_p95_ms");
    expect(body).toHaveProperty("cache_hit_rate");
    expect(body).toHaveProperty("marketplace_hit_rate");
    expect(body).toHaveProperty("live_capture_rate");
    expect(body).toHaveProperty("failure_rate");
    expect(body).toHaveProperty("skills_per_domain");
  });

  it("GET /v1/analytics/bottleneck rejects unauthenticated requests", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/analytics/bottleneck"), env);
    expect(res.status).toBe(401);
  });
});
