/**
 * Backend search performance regression tests.
 *
 * These tests hit the live beta-api.unbrowse.ai to verify that search
 * endpoints respond within acceptable latency bounds. They catch regressions
 * like the EdbKV cold-start issue (20-40s search cache load).
 *
 * Run: bun test backend/tests/search-perf.test.ts
 */
import { describe, it, expect } from "bun:test";

const API_URL = "https://beta-api.unbrowse.ai";

// Latency budgets (ms) — if a search exceeds these, something is wrong.
// These are generous (5x normal) to avoid flaky tests, but will catch
// catastrophic regressions like the 20-40s EdbKV cold-start.
const SEARCH_BUDGET_MS = 10_000;
const HEALTH_BUDGET_MS = 3_000;

async function timedPost(path: string, body: unknown): Promise<{ data: unknown; ms: number; status: number }> {
  const t0 = performance.now();
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { data, ms: Math.round(performance.now() - t0), status: res.status };
}

function expectSearchStatus(status: number, data: unknown): void {
  expect([200, 402]).toContain(status);
  if (status === 402) {
    expect((data as Record<string, unknown>)?.error).toBe("Payment Required");
  }
}

describe("Backend Search Latency", () => {
  it("health check responds within budget", async () => {
    const t0 = performance.now();
    const res = await fetch(`${API_URL}/health`);
    const ms = Math.round(performance.now() - t0);
    expect(res.ok).toBe(true);
    expect(ms).toBeLessThan(HEALTH_BUDGET_MS);
  }, 10_000);

  it("domain search responds within budget", async () => {
    const { ms, status, data } = await timedPost("/v1/search/domain", {
      intent: "get trending posts",
      domain: "producthunt.com",
      k: 3,
    });
    console.log(`  search/domain: ${ms}ms, status=${status}, results=${(data as any).results?.length ?? 0}`);
    expectSearchStatus(status, data);
    expect(ms).toBeLessThan(SEARCH_BUDGET_MS);
  }, 30_000);

  it("global search responds within budget", async () => {
    const { ms, status, data } = await timedPost("/v1/search", {
      intent: "get trending repositories",
      k: 5,
    });
    console.log(`  search/global: ${ms}ms, status=${status}, results=${(data as any).results?.length ?? 0}`);
    expectSearchStatus(status, data);
    expect(ms).toBeLessThan(SEARCH_BUDGET_MS);
  }, 30_000);

  it("parallel search (domain + global) within budget", async () => {
    const t0 = performance.now();
    const [domain, global_] = await Promise.all([
      timedPost("/v1/search/domain", { intent: "get sports scores", domain: "espn.com", k: 3 }),
      timedPost("/v1/search", { intent: "get sports scores", k: 5 }),
    ]);
    const wallMs = Math.round(performance.now() - t0);
    console.log(`  parallel: ${wallMs}ms wall (domain=${domain.ms}ms, global=${global_.ms}ms)`);
    expectSearchStatus(domain.status, domain.data);
    expectSearchStatus(global_.status, global_.data);
    expect(wallMs).toBeLessThan(SEARCH_BUDGET_MS);
  }, 30_000);

  it("repeated search stays within budget", async () => {
    const intent = `cache-test-${Date.now()}`;

    // First call
    const first = await timedPost("/v1/search", { intent, k: 3 });
    console.log(`  1st: ${first.ms}ms`);

    // Second call — may hit a different CF isolate, so don't assert cache speedup.
    // Just verify it's still within budget (catches the 40s regression).
    const second = await timedPost("/v1/search", { intent, k: 3 });
    console.log(`  2nd: ${second.ms}ms`);

    expectSearchStatus(first.status, first.data);
    expectSearchStatus(second.status, second.data);
    expect(first.ms).toBeLessThan(SEARCH_BUDGET_MS);
    expect(second.ms).toBeLessThan(SEARCH_BUDGET_MS);
  }, 30_000);
});
