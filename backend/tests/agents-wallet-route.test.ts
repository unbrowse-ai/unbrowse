import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../src/index.js";
import type { Env } from "../src/types.js";
import { statsKV } from "../src/services/kv.js";

const env: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "staging",
};

function createMockFetch(store: Map<string, string>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== "api.emergentdb.com") {
      throw new Error(`Unexpected fetch: ${url.toString()}`);
    }

    if (url.pathname === "/qdkv/set") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
      store.set(body.key, body.value);
      return Response.json({ ok: true });
    }

    // Batched index load (EdbKV._mget): { keys } -> { values: { key: value|null } }
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
      const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
      store.delete(key);
      return Response.json({ ok: true });
    }

    throw new Error(`Unexpected fetch: ${url.toString()}`);
  };
}

describe("agents wallet claim route", () => {
  const store = new Map<string, string>();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = createMockFetch(store) as typeof fetch;
    store.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("claims a wallet, stores it on the agent, and writes the lookup index", async () => {
    const res = await app.fetch(new Request("http://local.test/v1/agents/wallet", {
      method: "POST",
      headers: {
        Authorization: "Bearer alpha123456",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        wallet_address: "So1anaWallet11111111111111111111111111111111",
        wallet_provider: "lobster.cash",
      }),
    }), env);

    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; status: string };
    expect(body).toEqual({ ok: true, status: "claimed" });

    const stored = await statsKV(env).get("agent:staging_alpha123", "json") as { wallet_address?: string; wallet_provider?: string } | null;
    expect(stored?.wallet_address).toBe("So1anaWallet11111111111111111111111111111111");
    expect(stored?.wallet_provider).toBe("lobster.cash");
    expect(await statsKV(env).get("wallet:So1anaWallet11111111111111111111111111111111")).toBe("staging_alpha123");
  });
});
