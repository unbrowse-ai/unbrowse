import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests, statsKV } from "../src/services/kv.js";
import {
  enqueueMeterEvent,
  flushMeterRing,
} from "../src/services/stripe-meter-ring.js";

// Wave 4 W4-A. Real-app tests against the in-memory KV transport
// double + an inline Stripe mock that records calls.

const baseEnv: Env = {
  API_KEY: "admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "production",
  TURBOBOX_URL: "http://turbobox.local",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "fal",
  ENVIRONMENT: "production",
  RESEND_FROM: "Unbrowse <auth@auth.unbrowse.ai>",
  PUBLIC_API_URL: "http://api.local",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_METER_EVENT_NAME: "unbrowse_execute",
};

interface RecordedCall {
  body: { event_name: string; payload: { stripe_customer_id: string; value: string } };
  idempotencyKey: string | undefined;
}

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
      // Stub list -- our LocalKV/EdbKV list scans the index in-memory;
      // /qdkv/list/ is hit only by older code paths.
      return Response.json({ items: [] });
    }
    throw new Error(`Unexpected fetch: ${urlStr}`);
  }) as typeof fetch;
}

function makeStubStripe(calls: RecordedCall[], shouldFail = false) {
  return {
    billing: {
      meterEvents: {
        create: async (
          body: { event_name: string; payload: { stripe_customer_id: string; value: string } },
          opts?: { idempotencyKey?: string },
        ) => {
          if (shouldFail) throw new Error("simulated stripe failure");
          calls.push({ body, idempotencyKey: opts?.idempotencyKey });
          return { id: `mevt_${calls.length}` };
        },
      },
    },
  };
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

describe("W4-A enqueueMeterEvent", () => {
  it("writes a meter_ring:pending: KV entry", async () => {
    const key = await enqueueMeterEvent(baseEnv, {
      user_id: "u1",
      stripe_customer_id: "cus_1",
      execution_id: "exec_1",
      amount_uc: 1500,
    });
    expect(key).toMatch(/^meter_ring:pending:/);
    const stored = kvStore.get(`stats:${key}`);
    expect(stored).toBeDefined();
    const parsed = JSON.parse(stored!) as { amount_uc: number; queued_at: string };
    expect(parsed.amount_uc).toBe(1500);
    expect(typeof parsed.queued_at).toBe("string");
  });

  it("rejects events with missing required fields", async () => {
    expect(await enqueueMeterEvent(baseEnv, {
      user_id: "",
      stripe_customer_id: "cus_1",
      execution_id: "exec_1",
      amount_uc: 100,
    })).toBeNull();
    expect(await enqueueMeterEvent(baseEnv, {
      user_id: "u1",
      stripe_customer_id: "",
      execution_id: "exec_1",
      amount_uc: 100,
    })).toBeNull();
    expect(await enqueueMeterEvent(baseEnv, {
      user_id: "u1",
      stripe_customer_id: "cus_1",
      execution_id: "",
      amount_uc: 100,
    })).toBeNull();
  });

  it("rejects non-positive amounts", async () => {
    expect(await enqueueMeterEvent(baseEnv, {
      user_id: "u1",
      stripe_customer_id: "cus_1",
      execution_id: "exec_1",
      amount_uc: 0,
    })).toBeNull();
    expect(await enqueueMeterEvent(baseEnv, {
      user_id: "u1",
      stripe_customer_id: "cus_1",
      execution_id: "exec_1",
      amount_uc: -1,
    })).toBeNull();
  });
});

describe("W4-A flushMeterRing", () => {
  it("returns zero counts on empty ring", async () => {
    const r = await flushMeterRing(baseEnv, { stripe: makeStubStripe([]) });
    expect(r).toEqual({ flushed: 0, failed: 0, remaining: 0 });
  });

  it("drains a queued event to Stripe with the right idempotency key + payload", async () => {
    await enqueueMeterEvent(baseEnv, {
      user_id: "u_alice",
      stripe_customer_id: "cus_alice",
      execution_id: "exec_42",
      amount_uc: 5000,
    });
    const calls: RecordedCall[] = [];
    const r = await flushMeterRing(baseEnv, { stripe: makeStubStripe(calls) });
    expect(r.flushed).toBe(1);
    expect(r.failed).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0].body.event_name).toBe("unbrowse_execute");
    expect(calls[0].body.payload.stripe_customer_id).toBe("cus_alice");
    expect(calls[0].body.payload.value).toBe("5000");
    expect(calls[0].idempotencyKey).toBe("u_alice:exec_42");
  });

  it("leaves the entry in the ring on Stripe failure (next flush retries)", async () => {
    await enqueueMeterEvent(baseEnv, {
      user_id: "u_bob",
      stripe_customer_id: "cus_bob",
      execution_id: "exec_88",
      amount_uc: 100,
    });
    const r = await flushMeterRing(baseEnv, { stripe: makeStubStripe([], true) });
    expect(r.flushed).toBe(0);
    expect(r.failed).toBe(1);
    // The entry persists in KV so the next flush retries.
    const remaining = [...kvStore.keys()].filter((k) => k.includes("meter_ring:pending:"));
    expect(remaining.length).toBe(1);
  });

  it("respects STRIPE_METER_EVENT_NAME override and per-event override", async () => {
    const envOverride = { ...baseEnv, STRIPE_METER_EVENT_NAME: "custom_event" };
    await enqueueMeterEvent(envOverride, {
      user_id: "u_carol",
      stripe_customer_id: "cus_carol",
      execution_id: "exec_99",
      amount_uc: 750,
    });
    const calls: RecordedCall[] = [];
    await flushMeterRing(envOverride, { stripe: makeStubStripe(calls) });
    expect(calls[0]?.body.event_name).toBe("custom_event");

    await enqueueMeterEvent(envOverride, {
      user_id: "u_dave",
      stripe_customer_id: "cus_dave",
      execution_id: "exec_100",
      amount_uc: 1,
      event_name: "per_event_override",
    });
    const calls2: RecordedCall[] = [];
    await flushMeterRing(envOverride, { stripe: makeStubStripe(calls2) });
    expect(calls2[0]?.body.event_name).toBe("per_event_override");
  });
});
