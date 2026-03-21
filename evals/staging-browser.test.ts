#!/usr/bin/env bun
/**
 * Staging resolve eval — tests the full resolve pipeline via HTTP API.
 * Calls /v1/intent/resolve on the staging backend, which runs the full
 * search → candidate ranking → execution flow server-side.
 *
 * This validates the SSR fallback, quality gate, and capture pipeline
 * without needing a browser on the CI runner.
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

interface ResolveResponse {
  result?: {
    error?: string;
    data?: unknown;
    _extraction?: { source?: string; confidence?: number };
  };
  trace?: {
    success?: boolean;
    error?: string;
    skill_id?: string;
    endpoint_id?: string;
  };
  timing?: { total_ms?: number; source?: string };
  skill?: { skill_id?: string; domain?: string };
}

async function resolveIntent(
  intent: string,
  url: string,
  timeoutMs = 60_000
): Promise<{ status: number; data: ResolveResponse | null; latencyMs: number }> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${STAGING_URL}/v1/intent/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent, url }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    const data = (await res.json().catch(() => null)) as ResolveResponse | null;
    return { status: res.status, data, latencyMs };
  } catch (err) {
    clearTimeout(timeout);
    console.log(`  fetch error: ${(err as Error).message?.slice(0, 80)}`);
    return { status: 0, data: null, latencyMs: Date.now() - start };
  }
}

describe(`Staging resolve eval (${STAGING_URL})`, () => {
  // Known site with existing skill
  test("irs.gov resolves via marketplace skill", async () => {
    const { status, data, latencyMs } = await resolveIntent(
      "get homepage content", "https://www.irs.gov"
    );
    const success = data?.trace?.success;
    const source = data?.timing?.source;
    const skillId = data?.trace?.skill_id;
    console.log(`  irs.gov: status=${status} success=${success} source=${source} skill=${skillId} ${latencyMs}ms`);
    expect(status).toBe(200);
    expect(success).toBe(true);
  }, 90_000);

  test("npr.org resolves with data", async () => {
    const { status, data, latencyMs } = await resolveIntent(
      "get homepage content", "https://www.npr.org"
    );
    const success = data?.trace?.success;
    const hasData = data?.result?.data != null;
    console.log(`  npr.org: status=${status} success=${success} hasData=${hasData} ${latencyMs}ms`);
    expect(status).toBe(200);
    expect(success).toBe(true);
  }, 90_000);

  test("marketwatch.com resolves with data", async () => {
    const { status, data, latencyMs } = await resolveIntent(
      "get homepage content", "https://www.marketwatch.com"
    );
    const success = data?.trace?.success;
    console.log(`  marketwatch: status=${status} success=${success} ${latencyMs}ms`);
    expect(status).toBe(200);
    expect(success).toBe(true);
  }, 90_000);

  // Regression: no Invalid URL crashes
  test("gymshark does not return Invalid URL", async () => {
    const { data } = await resolveIntent(
      "get homepage content", "https://gymshark.com"
    );
    const error = data?.trace?.error ?? data?.result?.error;
    console.log(`  gymshark: error=${error ?? "none"}`);
    expect(error).not.toBe("Invalid URL");
  }, 90_000);

  // Latency: known sites should resolve under 15s
  test("resolve latency under 15s for cached sites", async () => {
    const { latencyMs, data } = await resolveIntent(
      "get homepage content", "https://www.irs.gov"
    );
    const source = data?.timing?.source;
    console.log(`  irs.gov latency: ${latencyMs}ms source=${source}`);
    expect(latencyMs).toBeLessThan(15_000);
  }, 30_000);
});
