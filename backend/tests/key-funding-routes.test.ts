/**
 * Key-funding routes — TEST-SPECS §3 gaps (AC-FUND-1/4/5).
 *
 * Through the real app with real keys (production-env hash verification):
 * wallet/credit bind + roundtrip, input validation, CROSS-TENANT rejection
 * (user B cannot read or write funding on user A's key), and the
 * registration auto-bind: POST /v1/agents/wallet wires the caller's key
 * funding without a separate call.
 *
 * Same harness as account-routes.test.ts: only the network boundary is
 * stubbed (Resend + EmergentDB-over-fetch incl. mget/list).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

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
} as unknown as Env;

let originalFetch: typeof fetch;
let kvStore: Map<string, string>;

function makeFetch(store: Map<string, string>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);

    if (url.hostname === "api.resend.com") {
      return new Response(JSON.stringify({ id: "resend-stub" }), { status: 200 });
    }
    if (url.hostname === "api.emergentdb.com") {
      if (url.pathname === "/qdkv/set") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
        store.set(body.key, body.value);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/qdkv/mget") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { keys?: string[] };
        const values: Record<string, string | null> = {};
        for (const k of body.keys ?? []) values[k] = store.get(k) ?? null;
        return Response.json({ values });
      }
      if (url.pathname.startsWith("/qdkv/get/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/get/", ""));
        const value = store.get(key);
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        store.delete(decodeURIComponent(url.pathname.replace("/qdkv/del/", "")));
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
    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

function req(path: string, opts: { method?: string; bearer?: string; body?: unknown } = {}): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
        "Content-Type": "application/json",
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    baseEnv,
  );
}

async function magicLinkBoundKey(email: string): Promise<{ key: string; keyId: string }> {
  const startRes = await req("/v1/auth/email/start", { method: "POST", body: { email } });
  const { token } = (await startRes.json()) as { token: string };
  await req(`/v1/auth/email/verify?token=${token}`);
  const pollRes = await req(`/v1/auth/email/poll?token=${token}`);
  const poll = (await pollRes.json()) as { api_key: string };
  const keysRes = await req("/v1/account/keys", { bearer: poll.api_key });
  const keys = (await keysRes.json()) as { keys: Array<{ keyId: string }> };
  return { key: poll.api_key, keyId: keys.keys[0].keyId };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  kvStore = new Map();
  globalThis.fetch = makeFetch(kvStore);
  clearKVCacheForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearKVCacheForTests();
});

describe("key funding bind + roundtrip (AC-FUND-1/2)", () => {
  it("binds wallet funding and reads it back", async () => {
    const a = await magicLinkBoundKey("fund-a@example.test");
    const post = await req(`/v1/account/keys/${a.keyId}/funding`, {
      method: "POST",
      bearer: a.key,
      body: { kind: "wallet", wallet: "So1FundingWallet11111111" },
    });
    expect(post.status).toBe(200);
    const get = await req(`/v1/account/keys/${a.keyId}/funding`, { bearer: a.key });
    const body = (await get.json()) as { funding: { kind: string; wallet: string } };
    expect(body.funding.kind).toBe("wallet");
    expect(body.funding.wallet).toBe("So1FundingWallet11111111");
  });

  it("binds credit funding with a floored positive budget; rejects invalid inputs", async () => {
    const a = await magicLinkBoundKey("fund-b@example.test");
    const ok = await req(`/v1/account/keys/${a.keyId}/funding`, {
      method: "POST",
      bearer: a.key,
      body: { kind: "credit", budget_uc: 1500.9 },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { funding: { budget_uc: number } }).funding.budget_uc).toBe(1500);

    for (const bad of [
      { kind: "credit", budget_uc: 0 },
      { kind: "credit", budget_uc: -5 },
      { kind: "wallet", wallet: "short" },
      { kind: "iou" },
    ]) {
      const res = await req(`/v1/account/keys/${a.keyId}/funding`, {
        method: "POST",
        bearer: a.key,
        body: bad,
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("cross-tenant isolation (AC-FUND-5)", () => {
  it("user B cannot read or write funding on user A's key (404, not 403 — no existence leak)", async () => {
    const a = await magicLinkBoundKey("tenant-a@example.test");
    const b = await magicLinkBoundKey("tenant-b@example.test");

    const write = await req(`/v1/account/keys/${a.keyId}/funding`, {
      method: "POST",
      bearer: b.key,
      body: { kind: "wallet", wallet: "So1AttackerWallet1111111" },
    });
    expect(write.status).toBe(404);

    const read = await req(`/v1/account/keys/${a.keyId}/funding`, { bearer: b.key });
    expect(read.status).toBe(404);

    // A's key remains unfunded — the attacker write did not land
    const own = await req(`/v1/account/keys/${a.keyId}/funding`, { bearer: a.key });
    expect(((await own.json()) as { funding: unknown }).funding).toBeNull();
  });
});

describe("registration auto-bind (AC-FUND-4)", () => {
  it("POST /v1/agents/wallet funds the caller's key without a separate funding call", async () => {
    const a = await magicLinkBoundKey("auto-bind@example.test");
    const claim = await req("/v1/agents/wallet", {
      method: "POST",
      bearer: a.key,
      body: { wallet_address: "So1AutoBoundWallet111111", wallet_provider: "lobster.cash" },
    });
    expect(claim.status).toBe(200);

    const funding = await req(`/v1/account/keys/${a.keyId}/funding`, { bearer: a.key });
    const body = (await funding.json()) as { funding: { kind: string; wallet: string } | null };
    expect(body.funding?.kind).toBe("wallet");
    expect(body.funding?.wallet).toBe("So1AutoBoundWallet111111");
  });
});
