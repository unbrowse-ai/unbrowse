/**
 * W24.4 — A5 silent-500 hazard regression suite.
 *
 * Proves that routes which previously called `c.env.STATS_KV.put/get` directly
 * no longer crash with a generic Hono 500 when the STATS_KV binding is
 * undefined. Each route now surfaces a typed 503 envelope:
 *
 *   { ok: false, _binding_missing: "STATS_KV", hint: "...", ...extras }
 *
 * Routes covered:
 *   - GET  /v1/blog/posts          (blog.ts L130, post-fix)
 *   - GET  /v1/blog/posts/:slug    (blog.ts L161, post-fix)
 *   - POST /v1/blog/publish        (blog.ts L101/107/111, post-fix)
 *   - POST /v1/stats/diagnostics   (stats.ts L300, post-fix)
 *   - POST /v1/contract/declare    (contract.ts indirect via kvLedger, post-fix)
 *
 * Sibling pattern: backend/tests/audit-binding-missing.test.ts (W4) — same
 * shape, different namespace. The cross-route consistency is what makes the
 * deployment-shape problem grep-able in CI logs.
 *
 * No mocks: real Hono apps, real route handlers, env shape that intentionally
 * omits STATS_KV. The 500 → 503 mapping IS the assertion.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { blogRoutes } from "../src/routes/blog";
import { statsRoutes } from "../src/routes/stats";
import { contractRoutes } from "../src/routes/contract";
import type { Env } from "../src/types";

/** Env shape with NO STATS_KV binding — the failure-mode under test. */
function envNoStatsKV(extra: Partial<Env> = {}): Partial<Env> {
  return {
    // ENVIRONMENT intentionally NOT "local-dev" so the contract route's
    // `ledgerForRequest` doesn't take the LocalKV fallback path. We want
    // the real binding-missing path under prod-shaped env.
    ENVIRONMENT: "production",
    // BLOG_PUBLISH_KEY required for blog/publish; supplied so the
    // 503 we assert isn't masked by the earlier 503 from the missing
    // publish key.
    BLOG_PUBLISH_KEY: "test-publish-key-w24",
    // No STATS_KV. No AUDIT_LOG. No EMERGENTDB_API_KEY. No DATABASE_URL.
    ...extra,
  };
}

function mountBlogApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/v1", blogRoutes);
  return app;
}

function mountStatsApp() {
  const app = new Hono<{ Bindings: Env; Variables: { agent_id: string } }>();
  app.route("/v1", statsRoutes);
  return app;
}

function mountContractApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/v1", contractRoutes);
  return app;
}

describe("W24.4 — STATS_KV binding-missing surfaces a typed 503 (not a silent 500)", () => {
  test("GET /v1/blog/posts with no STATS_KV returns 503 + envelope (not 500)", async () => {
    const app = mountBlogApp();
    const res = await app.request("/v1/blog/posts", {}, envNoStatsKV());
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body._binding_missing).toBe("STATS_KV");
    expect(typeof body.hint).toBe("string");
    expect((body.hint as string).toLowerCase()).toContain("wrangler kv:namespace create stats_kv");
  });

  test("GET /v1/blog/posts/:slug with no STATS_KV returns 503 + envelope (not 500)", async () => {
    const app = mountBlogApp();
    const res = await app.request("/v1/blog/posts/some-slug", {}, envNoStatsKV());
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body._binding_missing).toBe("STATS_KV");
    expect(body.slug).toBe("some-slug");
  });

  test("POST /v1/blog/publish with no STATS_KV returns 503 + envelope (not 500)", async () => {
    const app = mountBlogApp();
    const res = await app.request(
      "/v1/blog/publish",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer test-publish-key-w24",
        },
        body: JSON.stringify({
          slug: "w24-test",
          title: "W24 silent-500 regression",
          description: "ensure 503 envelope replaces 500 crash",
          content: "the binding is missing; the trumpet sounds honestly",
        }),
      },
      envNoStatsKV(),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body._binding_missing).toBe("STATS_KV");
    expect(body.slug).toBe("w24-test");
  });

  test("POST /v1/stats/diagnostics with no STATS_KV returns 503 + envelope (not 500)", async () => {
    const app = mountStatsApp();
    const res = await app.request(
      "/v1/stats/diagnostics",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          skill_id: "w24-skill",
          endpoint_id: "w24-endpoint",
          trace_version: "v7-w24",
        }),
      },
      envNoStatsKV(),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body._binding_missing).toBe("STATS_KV");
    expect(typeof body.key).toBe("string");
    expect((body.key as string).startsWith("diag:v7-w24:")).toBe(true);
  });

  test("POST /v1/contract/declare with no STATS_KV does NOT silent-500 — either 200 (in-memory fallback) or 503 envelope", async () => {
    // contract.ts has belt-and-suspenders: ledgerForRequest() short-circuits
    // to a processFallbackLedger when env lacks all storage indicators, so
    // declare typically succeeds with 200 + ephemeral ledger row even
    // without STATS_KV. If a downstream throw surfaces a binding-missing
    // shape, the route maps it to the typed 503 envelope (this wave's
    // defensive guard).
    const app = mountContractApp();
    const res = await app.request(
      "/v1/contract/declare",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          plan: "w24 silent-500 regression — ensure declare never 500s",
          action: "agent-judges",
        }),
      },
      envNoStatsKV(),
    );
    // Critical assertion: NEVER 500 under no-STATS_KV env.
    expect(res.status).not.toBe(500);
    expect([200, 503]).toContain(res.status);
    if (res.status === 503) {
      const body = (await res.json()) as Record<string, unknown>;
      expect(body._binding_missing).toBe("STATS_KV");
    }
  });
});
