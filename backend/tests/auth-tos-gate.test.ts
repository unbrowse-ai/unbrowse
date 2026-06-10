/**
 * ToS version gate + sign-in enumeration safety — TEST-SPECS §1 gaps
 * (AC-AUTH-4/AC-AUTH-6).
 *
 * - bearerAuth returns 403 tos_update_required (with re-accept pointer)
 *   when the agent profile carries a stale ToS version; fresh profiles
 *   auto-accept the current version and pass; bearerAuthNoTos bypasses
 *   the gate so the accept-tos endpoint stays reachable.
 * - POST /auth/email/start replies identically for any well-shaped email
 *   (it never consults account existence) — enumeration-safe — and
 *   rejects malformed emails before sending anything.
 *
 * Hermetic: local-dev KV lane; outbound email (Resend) is intercepted by
 * a fetch stub so no network leaves the test.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { bearerAuth, bearerAuthNoTos } from "../src/middleware/auth.js";
import { authRoutes } from "../src/routes/auth.js";
import { createLocalKey } from "../src/services/keys.js";
import { CURRENT_TOS_VERSION } from "../src/tos.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";
import type { Env } from "../src/types.js";

const ENV = {
  ENVIRONMENT: "local-dev",
  EMERGENTDB_API_KEY: "x",
  RESEND_API_KEY: "re_test_dummy",
  PUBLIC_FRONTEND_URL: "https://test.unbrowse.ai",
} as unknown as Env;

const realFetch = globalThis.fetch;
let outbound: string[] = [];

beforeEach(() => {
  clearKVCacheForTests();
  (new LocalKV("stats") as unknown as { store: Map<string, string> }).store.clear();
  outbound = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    outbound.push(String(url));
    return new Response(JSON.stringify({ id: "email_stub" }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function seedProfile(keyId: string, tosVersion: string | null) {
  const kv = new LocalKV("stats") as unknown as { store: Map<string, string> };
  kv.store.set(
    `agent:${keyId}`,
    JSON.stringify({
      agent_id: keyId,
      name: "tos-test-agent",
      created_at: "2026-01-01T00:00:00Z",
      skills_discovered: [],
      total_executions: 0,
      total_feedback_given: 0,
      tos_accepted_version: tosVersion,
      activity_dates: [],
    }),
  );
}

function authedApp(middleware: typeof bearerAuth) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", middleware as never);
  app.get("/probe", (c) => c.json({ ok: true }));
  return app;
}

describe("ToS version gate (AC-AUTH-6)", () => {
  test("stale accepted version → 403 tos_update_required with re-accept pointer", async () => {
    const { key, keyId } = await createLocalKey(ENV, "stale-tos");
    seedProfile(keyId, "2025-01-01-v0"); // older than CURRENT_TOS_VERSION
    const res = await authedApp(bearerAuth).request(
      "/probe",
      { headers: { Authorization: `Bearer ${key}` } },
      ENV,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("tos_update_required");
    expect(body.current_tos_version).toBe(CURRENT_TOS_VERSION);
    expect(body.accepted_version).toBe("2025-01-01-v0");
    expect(String(body.tos_url)).toContain("unbrowse.ai/terms");
  });

  test("fresh profile auto-accepts the current version and passes the gate", async () => {
    const { key } = await createLocalKey(ENV, "fresh-tos");
    // no seeded profile: ensureAgentProfile creates one at CURRENT_TOS_VERSION
    const res = await authedApp(bearerAuth).request(
      "/probe",
      { headers: { Authorization: `Bearer ${key}` } },
      ENV,
    );
    expect(res.status).toBe(200);
  });

  test("bearerAuthNoTos bypasses the gate so accept-tos stays reachable", async () => {
    const { key, keyId } = await createLocalKey(ENV, "stale-but-noTos");
    seedProfile(keyId, "2025-01-01-v0");
    const res = await authedApp(bearerAuthNoTos).request(
      "/probe",
      { headers: { Authorization: `Bearer ${key}` } },
      ENV,
    );
    expect(res.status).toBe(200);
  });
});

describe("email/start enumeration safety (AC-AUTH-1/AC-AUTH-4)", () => {
  function authApp() {
    const app = new Hono<{ Bindings: Env }>();
    app.route("/", authRoutes);
    return app;
  }

  async function start(email: string) {
    const res = await authApp().request(
      "/auth/email/start",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      },
      ENV,
    );
    return res;
  }

  test("replies with the same shape for any well-formed email — no account-existence signal", async () => {
    const a = await start("definitely-new-user@example.test");
    const b = await start("another-random-user@example.test");
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const bodyA = (await a.json()) as Record<string, unknown>;
    const bodyB = (await b.json()) as Record<string, unknown>;
    // identical key sets, no exists/registered/known flags
    expect(Object.keys(bodyA).sort()).toEqual(Object.keys(bodyB).sort());
    expect(Object.keys(bodyA).sort()).toEqual(["expires_in", "token"]);
  });

  test("malformed email → 400 invalid_email and no outbound send", async () => {
    const before = outbound.length;
    const res = await start("not-an-email");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_email");
    expect(outbound.length).toBe(before); // nothing dispatched
  });

  test("missing email body → 400, not a crash", async () => {
    const res = await authApp().request(
      "/auth/email/start",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ENV,
    );
    expect(res.status).toBe(400);
  });
});
