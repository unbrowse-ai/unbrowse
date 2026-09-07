/**
 * Contract 9474c6ab — Web2 subscription routes on accountRoutes.
 *
 * Tests the SOFT-FAIL path: when STRIPE_SECRET_KEY is unset, each of the
 * three new routes must return 503 `billing_not_configured` rather than
 * 500 / throw. We hit each route through the real `app` (no mocks of the
 * unit under test); auth is exercised by binding a fresh local key to a
 * fresh user, matching the pattern in account-routes.test.ts.
 *
 * The Stripe-wired (integration) leg lives behind the existing
 * billing-stripe-roundtrip harness gated on STRIPE_TEST_SECRET_KEY.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import { createLocalKey } from "../src/services/keys.js";
import { bindKeyToUser, upsertUser } from "../src/services/accounts.js";

const baseEnv: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "fal",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: "http://api.local",
};

let originalFetch: typeof fetch;
let kvStore: Map<string, string>;

function makeFetch(store: Map<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.hostname === "api.emergentdb.com") {
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        store.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = store.get(key);
        return Response.json(
          value == null ? { found: false, value: null } : { found: true, value },
        );
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        store.delete(key);
        return Response.json({ ok: true });
      }
      if (url.pathname.startsWith("/qdkv/list/")) {
        const prefix = decodeURIComponent(url.pathname.replace("/qdkv/list/", ""));
        const items = [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value }));
        return Response.json({ items });
      }
      return Response.json({ ok: true });
    }

    if (url.hostname === "api.resend.com") {
      return Response.json({ id: "stub" });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

interface BoundKey {
  apiKey: string;
  userId: string;
}

async function makeBoundKey(env: Env): Promise<BoundKey> {
  const email = `${crypto.randomUUID()}@test.local`;
  const user = await upsertUser(env, email, { verifyNow: true });
  const created = await createLocalKey(env, "test-key");
  await bindKeyToUser(env, created.keyId, user.user_id);
  return { apiKey: created.key, userId: user.user_id };
}

async function getReq(path: string, headers: Record<string, string> = {}, env: Env = baseEnv) {
  return app.fetch(new Request(`http://local.test${path}`, { headers }), env);
}

async function postJson(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  env: Env = baseEnv,
) {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );
}

beforeEach(() => {
  kvStore = new Map();
  originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetch(kvStore);
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

describe("contract 9474c6ab — billing routes soft-fail when Stripe is unconfigured", () => {
  it("POST /v1/account/billing-subscribe-url returns 503 billing_not_configured when STRIPE_SECRET_KEY missing", async () => {
    const { apiKey } = await makeBoundKey(baseEnv);
    const res = await postJson(
      "/v1/account/billing-subscribe-url",
      { plan_id: "pro" },
      { authorization: `Bearer ${apiKey}` },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("billing_not_configured");
  });

  it("POST /v1/account/billing-portal-url returns 503 billing_not_configured when STRIPE_SECRET_KEY missing", async () => {
    const { apiKey } = await makeBoundKey(baseEnv);
    const res = await postJson(
      "/v1/account/billing-portal-url",
      {},
      { authorization: `Bearer ${apiKey}` },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("billing_not_configured");
  });

  it("GET /v1/account/billing-status returns 503 billing_not_configured when STRIPE_SECRET_KEY missing", async () => {
    const { apiKey } = await makeBoundKey(baseEnv);
    const res = await getReq("/v1/account/billing-status", {
      authorization: `Bearer ${apiKey}`,
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("billing_not_configured");
  });
});

describe("contract 9474c6ab — billing routes reject unauthenticated callers", () => {
  it("POST /v1/account/billing-subscribe-url without bearer → 401", async () => {
    const res = await postJson("/v1/account/billing-subscribe-url", { plan_id: "pro" });
    expect([401, 403]).toContain(res.status);
  });

  it("POST /v1/account/billing-portal-url without bearer → 401", async () => {
    const res = await postJson("/v1/account/billing-portal-url", {});
    expect([401, 403]).toContain(res.status);
  });

  it("GET /v1/account/billing-status without bearer → 401", async () => {
    const res = await getReq("/v1/account/billing-status");
    expect([401, 403]).toContain(res.status);
  });
});

describe("contract 9474c6ab — routes are registered at the documented paths", () => {
  it("OPTIONS or method-mismatch returns a non-404 (route exists in the registry)", async () => {
    // Hitting POST with no Stripe still produces 503 (or 401) — never 404
    // — which proves the route is wired.
    const res = await postJson("/v1/account/billing-subscribe-url", {});
    expect(res.status).not.toBe(404);
  });

  it("subscribe-url + portal-url + status all live under /v1/account/*", async () => {
    const { apiKey } = await makeBoundKey(baseEnv);
    const headers = { authorization: `Bearer ${apiKey}` };
    const r1 = await postJson("/v1/account/billing-subscribe-url", {}, headers);
    const r2 = await postJson("/v1/account/billing-portal-url", {}, headers);
    const r3 = await getReq("/v1/account/billing-status", headers);
    for (const r of [r1, r2, r3]) {
      expect(r.status).not.toBe(404);
    }
  });
});
