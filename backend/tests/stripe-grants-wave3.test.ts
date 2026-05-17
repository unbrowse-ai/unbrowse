import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Env } from "../src/types.js";
import { clearKVCacheForTests, statsKV } from "../src/services/kv.js";
import {
  addUserCredits,
  debitUserCredits,
  getUserCreditBalance,
} from "../src/services/user-credits.js";
import {
  handleSubscriptionGrantEvent,
  type StripeSubscriptionEventLike,
} from "../src/services/stripe-grants.js";
import { KV_KEYS } from "../src/services/stripe.js";

// Wave 3 of unbrowse-payments-faremeter. Real-app, no-mock tests against
// the in-memory KV transport double, exercising user-credits.ts +
// stripe-grants.ts directly (no Stripe API call; the dispatcher is pure
// over the event payload + KV).

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
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_monthly_TEST",
  STRIPE_PRICE_METERED: "price_metered_TEST",
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
        return Response.json(value == null ? { found: false, value: null } : { found: true, value });
      }
      if (url.pathname.startsWith("/qdkv/del/")) {
        const key = decodeURIComponent(url.pathname.replace("/qdkv/del/", ""));
        store.delete(key);
        return Response.json({ ok: true });
      }
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${urlStr}`);
  }) as typeof fetch;
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

// Helper: seed the reverse customer->user index that getOrCreateCustomer
// would have written. We don't call Stripe here.
async function seedCustomerUserIndex(
  customer_id: string,
  user_id: string,
): Promise<void> {
  await statsKV(baseEnv).put(KV_KEYS.customerUser(customer_id), user_id);
}

function event(
  type: string,
  customer_id: string,
  priceIds: string[],
  status: string = "active",
  current_period_start: number = 1_700_000_000,
): StripeSubscriptionEventLike {
  return {
    type,
    data: {
      object: {
        id: "sub_123",
        customer: customer_id,
        status,
        current_period_start,
        items: { data: priceIds.map((id) => ({ price: { id } })) },
      },
    },
  };
}

describe("D1b user-credits ledger", () => {
  it("getUserCreditBalance returns a zero balance for an unknown user (no write)", async () => {
    const bal = await getUserCreditBalance(baseEnv, "user-fresh");
    expect(bal.user_id).toBe("user-fresh");
    expect(bal.granted_uc).toBe(0);
    expect(bal.earned_uc).toBe(0);
    expect(bal.consumed_uc).toBe(0);
    expect(bal.balance_uc).toBe(0);
    // No writes happened just from reading.
    expect([...kvStore.keys()].filter((k) => k.includes("user_credits:")).length).toBe(0);
  });

  it("addUserCredits accumulates across multiple grants", async () => {
    const a = await addUserCredits(baseEnv, "user-A", 100_000);
    expect(a.granted_uc).toBe(100_000);
    expect(a.balance_uc).toBe(100_000);
    clearKVCacheForTests();
    const b = await addUserCredits(baseEnv, "user-A", 50_000);
    expect(b.granted_uc).toBe(150_000);
    expect(b.balance_uc).toBe(150_000);
  });

  it("addUserCredits with 0 or negative is a no-op (returns existing balance)", async () => {
    await addUserCredits(baseEnv, "user-B", 50_000);
    clearKVCacheForTests();
    const zero = await addUserCredits(baseEnv, "user-B", 0);
    expect(zero.granted_uc).toBe(50_000);
    const neg = await addUserCredits(baseEnv, "user-B", -100);
    expect(neg.granted_uc).toBe(50_000);
  });

  it("debitUserCredits succeeds when balance covers and updates consumed/balance", async () => {
    await addUserCredits(baseEnv, "user-C", 100_000);
    clearKVCacheForTests();
    const r = await debitUserCredits(baseEnv, "user-C", 30_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.balance.consumed_uc).toBe(30_000);
      expect(r.balance.balance_uc).toBe(70_000);
      expect(r.balance.granted_uc).toBe(100_000);
    }
  });

  it("debitUserCredits refuses when insufficient (no mutation)", async () => {
    await addUserCredits(baseEnv, "user-D", 10_000);
    clearKVCacheForTests();
    const r = await debitUserCredits(baseEnv, "user-D", 99_999);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("insufficient");
      expect(r.balance.consumed_uc).toBe(0);
      expect(r.balance.balance_uc).toBe(10_000);
    }
  });
});

describe("D3b grant dispatcher: idempotency + customer->user resolution", () => {
  it("missing customer.id -> tier_no_grant", async () => {
    const e = event("customer.subscription.created", "", [], "active");
    e.data!.object!.customer = null;
    const r = await handleSubscriptionGrantEvent(baseEnv, e);
    expect(r.kind).toBe("tier_no_grant");
  });

  it("customer.id present but no user mapping -> no_customer_user_mapping", async () => {
    const r = await handleSubscriptionGrantEvent(
      baseEnv,
      event("customer.subscription.created", "cus_unknown", ["price_pro_monthly_TEST"]),
    );
    expect(r.kind).toBe("no_customer_user_mapping");
    if (r.kind === "no_customer_user_mapping") {
      expect(r.customer_id).toBe("cus_unknown");
    }
  });

  it("active Pro -> applied, 200k uc granted", async () => {
    await seedCustomerUserIndex("cus_alice", "user_alice");
    clearKVCacheForTests();
    const r = await handleSubscriptionGrantEvent(
      baseEnv,
      event("customer.subscription.created", "cus_alice", ["price_pro_monthly_TEST"]),
    );
    expect(r.kind).toBe("applied");
    if (r.kind === "applied") {
      expect(r.user_id).toBe("user_alice");
      expect(r.amount_uc).toBe(200_000);
      expect(r.balance.balance_uc).toBe(200_000);
    }
  });

  it("same event re-delivery -> duplicate, balance unchanged", async () => {
    await seedCustomerUserIndex("cus_bob", "user_bob");
    clearKVCacheForTests();
    const e = event("customer.subscription.created", "cus_bob", ["price_pro_monthly_TEST"], "active", 1_700_000_001);
    const first = await handleSubscriptionGrantEvent(baseEnv, e);
    expect(first.kind).toBe("applied");
    clearKVCacheForTests();
    const second = await handleSubscriptionGrantEvent(baseEnv, e);
    expect(second.kind).toBe("duplicate");
    clearKVCacheForTests();
    const bal = await getUserCreditBalance(baseEnv, "user_bob");
    expect(bal.granted_uc).toBe(200_000);
  });

  it("new period -> new grant fires (period_start drives idempotency, not event.id)", async () => {
    await seedCustomerUserIndex("cus_carol", "user_carol");
    clearKVCacheForTests();
    const r1 = await handleSubscriptionGrantEvent(
      baseEnv,
      event("customer.subscription.updated", "cus_carol", ["price_pro_monthly_TEST"], "active", 1_700_000_000),
    );
    expect(r1.kind).toBe("applied");
    clearKVCacheForTests();
    const r2 = await handleSubscriptionGrantEvent(
      baseEnv,
      event("customer.subscription.updated", "cus_carol", ["price_pro_monthly_TEST"], "active", 1_702_678_400),
    );
    expect(r2.kind).toBe("applied");
    clearKVCacheForTests();
    const bal = await getUserCreditBalance(baseEnv, "user_carol");
    expect(bal.granted_uc).toBe(400_000);
  });

  it("canceled subscription -> tier_no_grant, balance untouched", async () => {
    await seedCustomerUserIndex("cus_dave", "user_dave");
    await addUserCredits(baseEnv, "user_dave", 100_000);
    clearKVCacheForTests();
    const r = await handleSubscriptionGrantEvent(
      baseEnv,
      event("customer.subscription.deleted", "cus_dave", ["price_pro_monthly_TEST"], "canceled"),
    );
    expect(r.kind).toBe("tier_no_grant");
    clearKVCacheForTests();
    const bal = await getUserCreditBalance(baseEnv, "user_dave");
    expect(bal.granted_uc).toBe(100_000);
  });

  it("metered tier -> tier_no_grant (Meter API fires elsewhere)", async () => {
    await seedCustomerUserIndex("cus_eve", "user_eve");
    clearKVCacheForTests();
    const r = await handleSubscriptionGrantEvent(
      baseEnv,
      event("customer.subscription.created", "cus_eve", ["price_metered_TEST"]),
    );
    expect(r.kind).toBe("tier_no_grant");
    if (r.kind === "tier_no_grant") expect(r.tier).toBe("metered");
  });

  it("past_due Pro -> tier_no_grant (grant_uc=0 from inferTier)", async () => {
    await seedCustomerUserIndex("cus_fran", "user_fran");
    clearKVCacheForTests();
    const r = await handleSubscriptionGrantEvent(
      baseEnv,
      event("customer.subscription.updated", "cus_fran", ["price_pro_monthly_TEST"], "past_due"),
    );
    expect(r.kind).toBe("tier_no_grant");
    if (r.kind === "tier_no_grant") expect(r.tier).toBe("pro");
  });
});
