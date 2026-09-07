import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Context } from "hono";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests, statsKV } from "../src/services/kv.js";
import { fireMeterIfMetered } from "../src/services/meter-on-execute.js";
import { KV_KEYS } from "../src/services/stripe.js";

// Wave 5 W5-B. Pure-helper tests for the meter-fire wrapper.

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
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
  STRIPE_PRICE_METERED: "price_metered_test",
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
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${urlStr}`);
  }) as typeof fetch;
}

function mockCtx(user_id?: string): Context<{ Bindings: Env; Variables: { agent_id: string; user_id?: string } }> {
  const vars = new Map<string, string>();
  if (user_id) vars.set("user_id", user_id);
  return {
    env: baseEnv,
    get: ((k: string) => vars.get(k)) as never,
  } as never;
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

describe("W5-B fireMeterIfMetered", () => {
  it("anonymous user (no user_id) skips silently", async () => {
    const calls: Promise<unknown>[] = [];
    const r = await fireMeterIfMetered(mockCtx(undefined), {
      skill_id: "skill-x",
      price_usd: 0.01,
      schedule: (t) => calls.push(t),
    });
    expect(r).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("user without Stripe customer mapping skips silently", async () => {
    const r = await fireMeterIfMetered(mockCtx("user_no_stripe"), {
      skill_id: "skill-x",
      price_usd: 0.01,
      schedule: () => {},
    });
    expect(r).toBeNull();
  });

  it("user without subscription cache skips", async () => {
    await statsKV(baseEnv).put(KV_KEYS.userCustomer("user_a"), "cus_a");
    clearKVCacheForTests();
    const r = await fireMeterIfMetered(mockCtx("user_a"), {
      skill_id: "skill-x",
      price_usd: 0.01,
      schedule: () => {},
    });
    expect(r).toBeNull();
  });

  it("Free / no-price subscription skips", async () => {
    await statsKV(baseEnv).put(KV_KEYS.userCustomer("user_b"), "cus_b");
    await statsKV(baseEnv).put(KV_KEYS.customerSub("cus_b"), JSON.stringify({ status: "none" }));
    clearKVCacheForTests();
    const r = await fireMeterIfMetered(mockCtx("user_b"), {
      skill_id: "skill-x",
      price_usd: 0.01,
      schedule: () => {},
    });
    expect(r).toBeNull();
  });

  it("Pro subscription skips (Pro grants are flat, not per-execute)", async () => {
    await statsKV(baseEnv).put(KV_KEYS.userCustomer("user_pro"), "cus_pro");
    await statsKV(baseEnv).put(
      KV_KEYS.customerSub("cus_pro"),
      JSON.stringify({ status: "active", priceId: "price_pro_test" }),
    );
    clearKVCacheForTests();
    const r = await fireMeterIfMetered(mockCtx("user_pro"), {
      skill_id: "skill-x",
      price_usd: 0.01,
      schedule: () => {},
    });
    expect(r).toBeNull();
  });

  it("Metered subscription enqueues a meter event + schedules a flush", async () => {
    await statsKV(baseEnv).put(KV_KEYS.userCustomer("user_metered"), "cus_metered");
    await statsKV(baseEnv).put(
      KV_KEYS.customerSub("cus_metered"),
      JSON.stringify({ status: "active", priceId: "price_metered_test" }),
    );
    clearKVCacheForTests();
    const scheduled: Promise<unknown>[] = [];
    const r = await fireMeterIfMetered(mockCtx("user_metered"), {
      skill_id: "skill-y",
      price_usd: 0.0123,
      schedule: (t) => scheduled.push(t),
    });
    expect(r).toMatch(/^meter_ring:pending:/);
    expect(scheduled.length).toBe(1);
    // The flush will fail without a real Stripe client; we just await it to drain.
    await Promise.allSettled(scheduled);
    // The queued event was written to KV with the right user_id / customer_id.
    const stored = [...kvStore.entries()].find(([k]) => k.includes("meter_ring:pending:"));
    expect(stored).toBeDefined();
    const evt = JSON.parse(stored![1]) as { user_id: string; stripe_customer_id: string; amount_uc: number };
    expect(evt.user_id).toBe("user_metered");
    expect(evt.stripe_customer_id).toBe("cus_metered");
    expect(evt.amount_uc).toBe(12300); // 0.0123 USD * 1_000_000
  });
});
