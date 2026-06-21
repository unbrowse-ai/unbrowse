/**
 * Witness (jesus-ralph): unregistered CLI usage must LAND on the /internal dashboard.
 *
 * The client's recordAnalyticsSession POSTs /v1/analytics/sessions fire-and-forget; an
 * anonymous install has no API key. Before the fix, `analyticsRoutes.use("/analytics/*",
 * bearerAuth)` 401'd that POST → the client void-swallowed it → usage never landed →
 * /internal empty despite many npm installs.
 *
 * The fix: the session WRITE path accepts anonymous (optionalAuth), while the admin READ
 * paths (usage/funnel/etc.) stay bearer-gated. This test pins both:
 *   - anon POST /v1/analytics/sessions → 200 (lands, attributed to the anon/sentinel)
 *   - anon GET  /v1/analytics/usage    → 401 (admin read stays gated — fix is surgical)
 */
import { test, expect } from "bun:test";
import { Hono } from "hono";
import { analyticsRoutes } from "../src/routes/analytics.js";

function app() {
  const a = new Hono();
  a.route("/v1", analyticsRoutes);
  return a;
}

// ENVIRONMENT=local-dev makes statsKV(env) return an in-memory LocalKV (kv.ts:632), so the
// handler's session write succeeds without a real KV namespace. The fix under test is the
// optionalAuth wiring on the write path — not the storage backend.
const ENV = { ENVIRONMENT: "local-dev" } as Record<string, unknown>;

test("anonymous POST /v1/analytics/sessions lands (200) — usage reaches /internal", async () => {
  const res = await app().request(
    "/v1/analytics/sessions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "anon-witness-1", started_at: new Date(0).toISOString(), source: "test" }),
    },
    ENV,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});

test("anonymous GET /v1/analytics/usage stays bearer-gated (401) — admin read not loosened", async () => {
  const res = await app().request("/v1/analytics/usage", { method: "GET" }, ENV);
  expect(res.status).toBe(401);
});
