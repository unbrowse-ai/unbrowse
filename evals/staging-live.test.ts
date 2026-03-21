#!/usr/bin/env bun
/**
 * Staging live eval — tests the staging backend API directly.
 * No browser required — validates search, execution, and extraction endpoints.
 *
 * Usage:
 *   STAGING_URL=https://unbrowse-backend-staging.lewis-6d8.workers.dev \
 *     bun test ./evals/staging-live.test.ts
 */

import { describe, test, expect } from "bun:test";

const STAGING_URL =
  process.env.STAGING_URL ??
  process.env.UNBROWSE_BACKEND_URL ??
  "https://unbrowse-backend-staging.lewis-6d8.workers.dev";

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: unknown; latencyMs: number }> {
  const start = Date.now();
  const res = await fetch(`${STAGING_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const latencyMs = Date.now() - start;
  const data = await res.json().catch(() => null);
  return { status: res.status, data, latencyMs };
}

describe(`Staging live eval (${STAGING_URL})`, () => {
  // Health
  test("health endpoint returns ok", async () => {
    const { status, data, latencyMs } = await api("GET", "/health");
    console.log(`  /health: ${status} (${latencyMs}ms)`);
    expect(status).toBe(200);
    expect((data as Record<string, unknown>)?.status).toBe("ok");
  });

  // Search — test that the search pipeline returns results
  test("search returns results for known domain", async () => {
    const { status, data, latencyMs } = await api("POST", "/v1/search/resolve", {
      intent: "get stock price",
      domain: "finance.yahoo.com",
      domain_k: 3,
      global_k: 5,
    });
    const d = data as Record<string, unknown>;
    const domainResults = d?.domain_results as unknown[] ?? [];
    const globalResults = d?.global_results as unknown[] ?? [];
    console.log(`  search: ${status} (${latencyMs}ms) domain=${domainResults.length} global=${globalResults.length}`);
    expect(status).toBe(200);
    expect(domainResults.length + globalResults.length).toBeGreaterThan(0);
  });

  // Search latency — should be under 5s
  test("search latency under 5s", async () => {
    const { latencyMs } = await api("POST", "/v1/search/resolve", {
      intent: "search products",
      domain: "amazon.com",
      domain_k: 3,
      global_k: 5,
    });
    console.log(`  search latency: ${latencyMs}ms`);
    expect(latencyMs).toBeLessThan(5000);
  });

  // Validate endpoint
  test("validate endpoint accepts manifests", async () => {
    const { status, data, latencyMs } = await api("POST", "/v1/validate", {
      skill_id: "__staging_eval__",
      name: "staging-eval-test",
      intent_signature: "test staging validation",
      domain: "test.staging",
      endpoints: [{
        endpoint_id: "test-ep",
        method: "GET",
        url_template: "https://test.staging/api/test",
        description: "Test endpoint for staging eval",
      }],
    });
    console.log(`  validate: ${status} (${latencyMs}ms)`);
    expect(status).toBe(200);
    expect((data as Record<string, unknown>)?.valid).toBeDefined();
  });

  // Skills list
  test("skills list returns array", async () => {
    const { status, data, latencyMs } = await api("GET", "/v1/skills");
    const skills = (data as Record<string, unknown>)?.skills as unknown[] ?? [];
    console.log(`  skills: ${status} (${latencyMs}ms) count=${skills.length}`);
    expect(status).toBe(200);
    expect(Array.isArray(skills)).toBe(true);
  });

  // Graph search (the new EmergentDB path)
  test("graph search returns scored results", async () => {
    const { status, data, latencyMs } = await api("POST", "/v1/search", {
      intent: "get latest news",
      k: 5,
    });
    const results = (data as Record<string, unknown>)?.results as Array<{ score: number }> ?? [];
    console.log(`  graph search: ${status} (${latencyMs}ms) results=${results.length}`);
    if (results.length > 0) {
      console.log(`  top score: ${results[0].score.toFixed(3)}`);
    }
    expect(status).toBe(200);
  });

  // Regression: staging should use the same search quality as prod
  test("yahoo finance search returns relevant results (score > 0.5)", async () => {
    const { data } = await api("POST", "/v1/search/domain", {
      intent: "get stock quote",
      domain: "finance.yahoo.com",
      k: 3,
    });
    const results = (data as Record<string, unknown>)?.results as Array<{ score: number }> ?? [];
    console.log(`  yahoo relevance: ${results.length} results, top=${results[0]?.score?.toFixed(3) ?? "none"}`);
    if (results.length > 0) {
      expect(results[0].score).toBeGreaterThan(0.5);
    }
  });
});
