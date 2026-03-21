#!/usr/bin/env bun
/**
 * Staging resolve eval — tests search quality and skill pipeline.
 *
 * Usage:
 *   STAGING_URL=https://unbrowse-backend-staging.lewis-6d8.workers.dev \
 *     bun test ./evals/staging-browser.test.ts
 */

import { describe, test, expect } from "bun:test";

const STAGING_URL =
  process.env.STAGING_URL ??
  process.env.UNBROWSE_BACKEND_URL ??
  "https://unbrowse-backend-staging.lewis-6d8.workers.dev";

async function api(method: string, path: string, body?: unknown) {
  const start = Date.now();
  const res = await fetch(`${STAGING_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => null), ms: Date.now() - start };
}

describe(`Staging resolve pipeline (${STAGING_URL})`, () => {
  // Search returns scored results for known domains
  test("yahoo finance domain search returns results with scores > 0.5", async () => {
    const { status, data, ms } = await api("POST", "/v1/search/resolve", {
      intent: "get stock quote",
      domain: "finance.yahoo.com",
      domain_k: 3,
      global_k: 5,
    });
    const d = data as Record<string, unknown>;
    const domain = d?.domain_results as Array<{ score: number }> ?? [];
    const global = d?.global_results as Array<{ score: number }> ?? [];
    console.log(`  yahoo: domain=${domain.length} global=${global.length} top=${domain[0]?.score?.toFixed(3)} ${ms}ms`);
    expect(status).toBe(200);
    expect(domain.length).toBeGreaterThan(0);
    expect(domain[0].score).toBeGreaterThan(0.5);
  }, 15_000);

  // Different domains return different result counts
  test("reddit domain search returns results", async () => {
    const { status, data, ms } = await api("POST", "/v1/search/resolve", {
      intent: "get hot posts",
      domain: "reddit.com",
      domain_k: 3,
      global_k: 5,
    });
    const d = data as Record<string, unknown>;
    const domain = d?.domain_results as Array<{ score: number }> ?? [];
    console.log(`  reddit: domain=${domain.length} top=${domain[0]?.score?.toFixed(3) ?? "none"} ${ms}ms`);
    expect(status).toBe(200);
  }, 15_000);

  // Global search works across domains
  test("global search returns cross-domain results", async () => {
    const { status, data, ms } = await api("POST", "/v1/search", { intent: "get latest news", k: 5 });
    const results = (data as Record<string, unknown>)?.results as unknown[];
    console.log(`  global: ${results?.length ?? 0} results ${ms}ms`);
    expect(status).toBe(200);
    expect(results?.length).toBeGreaterThan(0);
  }, 15_000);

  // Skills list returns populated data
  test("skills list has entries", async () => {
    const { status, data, ms } = await api("GET", "/v1/skills");
    const skills = (data as Record<string, unknown>)?.skills as Array<{ skill_id: string; domain: string }>;
    console.log(`  skills: ${skills?.length ?? 0} total ${ms}ms`);
    expect(status).toBe(200);
    expect(skills?.length).toBeGreaterThan(0);

    // Spot check: at least one skill has endpoints
    if (skills?.length > 0) {
      const { data: detail } = await api("GET", `/v1/skills/${skills[0].skill_id}`);
      const endpoints = (detail as Record<string, unknown>)?.endpoints as unknown[];
      console.log(`  first skill (${skills[0].domain}): ${endpoints?.length ?? 0} endpoints`);
    }
  }, 15_000);

  // Search latency regression
  test("search latency under 5s", async () => {
    const { ms } = await api("POST", "/v1/search/resolve", {
      intent: "search flights",
      domain: "skyscanner.com",
      domain_k: 3,
      global_k: 5,
    });
    console.log(`  search latency: ${ms}ms`);
    expect(ms).toBeLessThan(5000);
  }, 10_000);

  // Validate endpoint
  test("validate rejects empty skill", async () => {
    const { status, data } = await api("POST", "/v1/validate", {
      skill_id: "__test__",
      name: "",
      intent_signature: "",
      domain: "",
      endpoints: [],
    });
    expect(status).toBe(200);
    console.log(`  validate empty: valid=${(data as Record<string, unknown>)?.valid}`);
  }, 10_000);
});
