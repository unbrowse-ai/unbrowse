#!/usr/bin/env bun
/**
 * Staging smoke test — runs against the staging backend after deploy.
 * Validates that the backend is healthy and core flows work.
 *
 * Set STAGING_URL env var to override the default staging endpoint.
 *
 * Usage:
 *   STAGING_URL=https://unbrowse-backend-staging.lewis-6d8.workers.dev \
 *     bun test ./evals/staging-smoke.test.ts
 */

import { describe, test, expect } from "bun:test";

const STAGING_URL =
  process.env.STAGING_URL ?? "https://unbrowse-backend-staging.lewis-6d8.workers.dev";

async function stagingFetch(
  path: string,
  opts?: { method?: string; body?: unknown }
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${STAGING_URL}${path}`, {
    method: opts?.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts?.body ? {} : {}),
    },
    ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

describe(`Staging smoke (${STAGING_URL})`, () => {
  test("health endpoint returns ok", async () => {
    const { status, data } = await stagingFetch("/health");
    console.log(`  /health: ${status}`);
    expect(status).toBe(200);
    expect((data as Record<string, unknown>)?.status).toBe("ok");
  });

  test("search endpoint accepts requests", async () => {
    const { status, data } = await stagingFetch("/v1/search/resolve", {
      method: "POST",
      body: { intent: "get stock price", domain: "finance.yahoo.com", domain_k: 3, global_k: 5 },
    });
    console.log(`  /v1/search/resolve: ${status}, results=${Array.isArray((data as Record<string, unknown>)?.domain_results) ? ((data as Record<string, unknown>).domain_results as unknown[]).length : "?"}`);
    expect(status).toBe(200);
  });

  test("validate endpoint works", async () => {
    const { status } = await stagingFetch("/v1/validate", {
      method: "POST",
      body: {
        skill_id: "__smoke_test__",
        name: "smoke",
        intent_signature: "test",
        domain: "test.com",
        endpoints: [],
      },
    });
    console.log(`  /v1/validate: ${status}`);
    expect(status).toBe(200);
  });

  test("skills list endpoint works", async () => {
    const { status } = await stagingFetch("/v1/skills");
    console.log(`  /v1/skills: ${status}`);
    expect(status).toBe(200);
  });
});
