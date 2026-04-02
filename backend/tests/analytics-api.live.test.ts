import { describe, expect, it } from "bun:test";

const ANALYTICS_TEST_RUN = process.env.ANALYTICS_TEST_RUN === "1";
const API_URL = process.env.ANALYTICS_TEST_API_URL ?? "https://beta-api.unbrowse.ai";
const API_KEY = process.env.ANALYTICS_TEST_API_KEY ?? "";
const liveDescribe = ANALYTICS_TEST_RUN ? describe : describe.skip;

async function request(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (API_KEY) headers.set("Authorization", `Bearer ${API_KEY}`);
  if (!headers.has("Content-Type") && init?.body) headers.set("Content-Type", "application/json");
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  return { status: res.status, data: await res.json() as Record<string, unknown> };
}

liveDescribe("analytics API — live smoke", () => {
  it("accepts session summaries and serves the dashboard routes", async () => {
    const post = await request("/v1/analytics/sessions", {
      method: "POST",
      body: JSON.stringify({
        session_id: `live-smoke-${Date.now()}`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        api_calls: 1,
        discovery_queries: 1,
        cached_skill_calls: 1,
        fresh_index_calls: 0,
        browser_mode: "unknown",
      }),
    });
    expect(post.status).toBe(200);

    const dashboard = await request("/v1/analytics/dashboard");
    expect(dashboard.status).toBe(200);
    expect(dashboard.data).toHaveProperty("funnel");
    expect(dashboard.data).toHaveProperty("growth");
    expect(dashboard.data).toHaveProperty("economics");

    const funnel = await request("/v1/analytics/funnel");
    expect(funnel.status).toBe(200);
    expect(Array.isArray(funnel.data.stages)).toBe(true);
  });
});
