import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { app } from "../src/index.js";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests } from "../src/services/kv.js";

// Seed-step tests for /v1/claim/*. The handlers do NOT yet touch KV or DoH —
// they just validate inputs and return placeholder envelopes. Bringing up the
// real Hono app proves the routes are mounted at the expected paths.
//
// staging environment makes bearerAuth accept any bearer token, so we can
// exercise the gated POST endpoints without provisioning a real key.

const baseEnv: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
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
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        store.delete(key);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch in test: ${urlStr}`);
  }) as typeof fetch;
}

async function postJson(path: string, body: unknown, bearer = "stub-key"): Promise<Response> {
  return app.fetch(
    new Request(`http://local.test${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    }),
    baseEnv,
  );
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

describe("/v1/claim/* seed contract", () => {
  it("1. POST /claim/challenge with valid apex domain + valid Solana wallet returns 200 with envelope shape", async () => {
    const res = await postJson("/v1/claim/challenge", {
      domain: "news.ycombinator.com",
      wallet_address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      domain: string;
      wallet_address: string;
      challenge: string;
      txt_name: string;
      txt_value: string;
      expires_at: string;
    };
    expect(body.domain).toBe("news.ycombinator.com");
    expect(body.wallet_address).toBe("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    expect(body.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(body.txt_name).toBe("_unbrowse-claim.news.ycombinator.com");
    expect(body.txt_value).toBe(
      `unbrowse-claim=${body.challenge};wallet=9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin`,
    );
    expect(() => new Date(body.expires_at).toISOString()).not.toThrow();
    expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("2. POST /claim/challenge rejects subdomain hint www.example.com with 400 invalid_domain", async () => {
    const res = await postJson("/v1/claim/challenge", {
      domain: "www.example.com",
      wallet_address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_domain");
  });

  it("3. POST /claim/challenge rejects malformed wallet with 400 invalid_wallet", async () => {
    const res = await postJson("/v1/claim/challenge", {
      domain: "example.com",
      wallet_address: "xxx",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_wallet");
  });

  it("4. POST /claim/verify with no prior challenge returns 404 no_challenge", async () => {
    // /v1/claim/verify is now wired (Step 5). Without a prior challenge KV
    // row, the handler must surface 404 no_challenge so the caller knows to
    // mint one. This pins the contract from firmament-step2.md "Endpoints"
    // before the DoH happy-path test in claim-verify-e2e.test.ts.
    const res = await postJson("/v1/claim/verify", {
      domain: "example.com",
      wallet_address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_challenge");
  });
});
