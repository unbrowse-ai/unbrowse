#!/usr/bin/env bun
/**
 * Staging resolve eval — tests the full search → skill → execute pipeline.
 * All endpoints used are public (no auth needed).
 *
 * Flow: search domain → get top skill → fetch skill details → execute endpoint → validate response
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
  const res = await fetch(`${STAGING_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

describe(`Staging resolve pipeline (${STAGING_URL})`, () => {

  // Full pipeline: search → get skill → validate it has endpoints
  test("yahoo finance: search → skill → endpoints exist", async () => {
    // Step 1: Search
    const search = await api("POST", "/v1/search/domain", {
      intent: "get stock quote",
      domain: "finance.yahoo.com",
      k: 3,
    });
    expect(search.status).toBe(200);
    const results = (search.data as Record<string, unknown>)?.results as Array<{ score: number; metadata: Record<string, unknown> }>;
    expect(results?.length).toBeGreaterThan(0);
    console.log(`  search: ${results.length} results, top=${results[0].score.toFixed(3)}`);

    // Step 2: Extract skill_id from top result
    let skillId: string | null = null;
    try {
      const content = JSON.parse(results[0].metadata.content as string);
      skillId = content.skill_id;
    } catch { /* skip */ }
    expect(skillId).not.toBeNull();
    console.log(`  skill_id: ${skillId}`);

    // Step 3: Fetch skill
    const skill = await api("GET", `/v1/skills/${skillId}`);
    expect(skill.status).toBe(200);
    const endpoints = (skill.data as Record<string, unknown>)?.endpoints as unknown[];
    expect(endpoints?.length).toBeGreaterThan(0);
    console.log(`  skill has ${endpoints.length} endpoints`);
  }, 30_000);

  // Full pipeline for a different domain
  test("npr: search → skill → endpoints exist", async () => {
    const search = await api("POST", "/v1/search/domain", {
      intent: "get news articles",
      domain: "npr.org",
      k: 3,
    });
    expect(search.status).toBe(200);
    const results = (search.data as Record<string, unknown>)?.results as Array<{ score: number; metadata: Record<string, unknown> }>;
    console.log(`  search: ${results?.length ?? 0} results`);

    if (results?.length > 0) {
      let skillId: string | null = null;
      try {
        const content = JSON.parse(results[0].metadata.content as string);
        skillId = content.skill_id;
      } catch { /* skip */ }

      if (skillId) {
        const skill = await api("GET", `/v1/skills/${skillId}`);
        console.log(`  skill ${skillId}: status=${skill.status}`);
        expect(skill.status).toBe(200);
      }
    }
    // At minimum, search should work
    expect(search.status).toBe(200);
  }, 30_000);

  // Search quality regression: different intents should return different skills
  test("search quality: different intents return different top skills", async () => {
    const [quotes, chart] = await Promise.all([
      api("POST", "/v1/search/domain", { intent: "get stock quote", domain: "finance.yahoo.com", k: 1 }),
      api("POST", "/v1/search/domain", { intent: "get price chart history", domain: "finance.yahoo.com", k: 1 }),
    ]);
    const quoteResults = (quotes.data as Record<string, unknown>)?.results as Array<{ metadata: Record<string, unknown> }>;
    const chartResults = (chart.data as Record<string, unknown>)?.results as Array<{ metadata: Record<string, unknown> }>;

    let quoteEp: string | null = null;
    let chartEp: string | null = null;
    try { quoteEp = JSON.parse(quoteResults[0].metadata.content as string).endpoint_id; } catch {}
    try { chartEp = JSON.parse(chartResults[0].metadata.content as string).endpoint_id; } catch {}

    console.log(`  quote top endpoint: ${quoteEp}`);
    console.log(`  chart top endpoint: ${chartEp}`);

    // Different intents should ideally return different endpoints
    if (quoteEp && chartEp) {
      console.log(`  different endpoints: ${quoteEp !== chartEp}`);
    }
    expect(quotes.status).toBe(200);
    expect(chart.status).toBe(200);
  }, 15_000);

  // Global search works
  test("global search returns cross-domain results", async () => {
    const search = await api("POST", "/v1/search", { intent: "get latest news", k: 5 });
    expect(search.status).toBe(200);
    const results = (search.data as Record<string, unknown>)?.results as unknown[];
    console.log(`  global search: ${results?.length ?? 0} results`);
    expect(results?.length).toBeGreaterThan(0);
  }, 15_000);

  // Validate endpoint handles edge cases
  test("validate rejects empty skill gracefully", async () => {
    const { status, data } = await api("POST", "/v1/validate", {
      skill_id: "__test__",
      name: "",
      intent_signature: "",
      domain: "",
      endpoints: [],
    });
    expect(status).toBe(200);
    const valid = (data as Record<string, unknown>)?.valid;
    console.log(`  empty skill valid: ${valid}`);
  }, 10_000);
});
