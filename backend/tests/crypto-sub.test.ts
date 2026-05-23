/**
 * Contract organ 1682152a stage B — monthly USDC subscription, ported
 * from aiko-v2's crypto-sub.ts into unbrowse-canonical surface.
 *
 * Tests the core service-level invariants:
 *   1. Quote returns the configured USD amount + canonical 30-day period.
 *   2. Conflict detection refuses to mint a crypto sub when an active
 *      Stripe sub OR an active crypto sub already exists for the user.
 *   3. Activation writes the canonical STRIPE_SUB_CACHE shape into KV at
 *      the same `stripe:user:` / `stripe:customer:` keys the Stripe path
 *      uses — read-side gating sees no difference.
 *   4. Intent factory carries the correct fields + 10-min TTL convention.
 *
 * Per CLAUDE.md "Never mock in tests": real `activateCryptoSubscription` /
 * `assertNoStripeConflict` against an in-memory KV stand-in (same pattern
 * as sponsor-pool-flywheel-closure.test.ts).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  activateCryptoSubscription,
  amountForPlan,
  assertNoStripeConflict,
  loadIntent,
  newCryptoSubIntent,
  planFromParam,
  priceIdForPlan,
  quoteForPlan,
  saveIntent,
  THIRTY_DAYS_SECONDS,
  type CryptoSubPlan,
} from "../src/services/crypto-sub.js";
import { KV_KEYS } from "../src/services/stripe.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import type { Env } from "../src/types.js";

function makeMemoryKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    STATS_KV: makeMemoryKv(),
    STRIPE_PRICE_BASE: "price_base_test",
    STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
    ...overrides,
  } as unknown as Env;
}

describe("crypto-sub plan + quote (stage B)", () => {
  beforeEach(() => clearKVCacheForTests());

  test("planFromParam accepts only 'base' and 'pro'", () => {
    expect(planFromParam("base")).toBe("base");
    expect(planFromParam("pro")).toBe("pro");
    expect(planFromParam("enterprise")).toBeNull();
    expect(planFromParam(undefined)).toBeNull();
    expect(planFromParam("")).toBeNull();
  });

  test("amountForPlan defaults to $19 / $59 when env unset", () => {
    const env = makeEnv();
    expect(amountForPlan(env, "base")).toBe("19");
    expect(amountForPlan(env, "pro")).toBe("59");
  });

  test("amountForPlan honors env override", () => {
    const env = makeEnv({ CRYPTO_BASE_USDC: "29", CRYPTO_PRO_USDC: "99" });
    expect(amountForPlan(env, "base")).toBe("29");
    expect(amountForPlan(env, "pro")).toBe("99");
  });

  test("priceIdForPlan reads STRIPE_PRICE_* env", () => {
    const env = makeEnv();
    expect(priceIdForPlan(env, "base")).toBe("price_base_test");
    expect(priceIdForPlan(env, "pro")).toBe("price_pro_test");
  });

  test("quoteForPlan carries plan + amount + 30-day period", () => {
    const env = makeEnv();
    const q = quoteForPlan(env, "base");
    expect(q.plan).toBe("base");
    expect(q.amount).toBe("19");
    expect(q.currency).toBe("USDC");
    expect(q.protocol).toBe("x402");
    expect(q.periodSeconds).toBe(THIRTY_DAYS_SECONDS);
  });
});

describe("crypto-sub conflict detection (firmament invariant)", () => {
  beforeEach(() => clearKVCacheForTests());

  test("returns null when user has no existing subscription", async () => {
    const env = makeEnv();
    const conflict = await assertNoStripeConflict(env, "user_clean");
    expect(conflict).toBeNull();
  });

  test("returns null when existing sub is inactive (canceled)", async () => {
    const env = makeEnv();
    await env.STATS_KV.put(KV_KEYS.userCustomer("user_x"), "cus_123");
    await env.STATS_KV.put(
      KV_KEYS.customerSub("cus_123"),
      JSON.stringify({ status: "canceled" }),
    );
    const conflict = await assertNoStripeConflict(env, "user_x");
    expect(conflict).toBeNull();
  });

  test("refuses with 'stripe_sub_active' when active Stripe sub exists", async () => {
    const env = makeEnv();
    await env.STATS_KV.put(KV_KEYS.userCustomer("user_s"), "cus_456");
    await env.STATS_KV.put(
      KV_KEYS.customerSub("cus_456"),
      JSON.stringify({ status: "active" }),
    );
    const conflict = await assertNoStripeConflict(env, "user_s");
    expect(conflict?.kind).toBe("stripe_sub_active");
    expect(conflict?.message).toContain("Cancel your Stripe subscription");
  });

  test("refuses with 'stripe_sub_active' for trialing Stripe sub too", async () => {
    const env = makeEnv();
    await env.STATS_KV.put(KV_KEYS.userCustomer("user_t"), "cus_789");
    await env.STATS_KV.put(
      KV_KEYS.customerSub("cus_789"),
      JSON.stringify({ status: "trialing" }),
    );
    const conflict = await assertNoStripeConflict(env, "user_t");
    expect(conflict?.kind).toBe("stripe_sub_active");
  });

  test("refuses with 'crypto_sub_active' when crypto sub already active", async () => {
    const env = makeEnv();
    await env.STATS_KV.put(KV_KEYS.userCustomer("user_c"), "crypto-user_c");
    await env.STATS_KV.put(
      KV_KEYS.customerSub("crypto-user_c"),
      JSON.stringify({ status: "active" }),
    );
    const conflict = await assertNoStripeConflict(env, "user_c");
    expect(conflict?.kind).toBe("crypto_sub_active");
  });
});

describe("crypto-sub activation writes canonical STRIPE_SUB_CACHE", () => {
  beforeEach(() => clearKVCacheForTests());

  test("activate writes both customer row + reverse index + customerUser", async () => {
    const env = makeEnv();
    const result = await activateCryptoSubscription(env, {
      userId: "user_a",
      plan: "base",
      priceId: "price_base_test",
    });

    expect(result.customerId).toBe("crypto-user_a");
    expect(result.cache.status).toBe("active");
    expect(result.cache.priceId).toBe("price_base_test");
    expect(result.cache.paymentMethod).toBeNull();
    expect(result.cache.cancelAtPeriodEnd).toBe(false);
    expect(result.cache.quota).toBe(200_000); // base default

    // KV side-effects observable via read-back
    const userRow = await env.STATS_KV.get(KV_KEYS.userCustomer("user_a"));
    expect(userRow).toBe("crypto-user_a");

    const subRow = await env.STATS_KV.get(KV_KEYS.customerSub("crypto-user_a"));
    expect(subRow).not.toBeNull();
    const parsedSub = JSON.parse(subRow as string);
    expect(parsedSub.status).toBe("active");
    expect(parsedSub.quota).toBe(200_000);

    // Reverse index for webhook customer.id → user_id resolution
    const reverseRow = await env.STATS_KV.get(KV_KEYS.customerUser("crypto-user_a"));
    expect(reverseRow).toBe("user_a");
  });

  test("pro plan gets the larger quota by default", async () => {
    const env = makeEnv();
    const result = await activateCryptoSubscription(env, {
      userId: "user_p",
      plan: "pro",
      priceId: "price_pro_test",
    });
    expect(result.cache.quota).toBe(1_000_000);
  });

  test("custom quota via CRYPTO_*_QUOTA env vars", async () => {
    const env = makeEnv({ CRYPTO_BASE_QUOTA: "555000", CRYPTO_PRO_QUOTA: "9999000" });
    const base = await activateCryptoSubscription(env, {
      userId: "user_b",
      plan: "base",
      priceId: "price_base_test",
    });
    expect(base.cache.quota).toBe(555_000);

    const pro = await activateCryptoSubscription(env, {
      userId: "user_pp",
      plan: "pro",
      priceId: "price_pro_test",
    });
    expect(pro.cache.quota).toBe(9_999_000);
  });

  test("currentPeriodEnd is exactly 30 days after currentPeriodStart", async () => {
    const env = makeEnv();
    const result = await activateCryptoSubscription(env, {
      userId: "user_period",
      plan: "base",
      priceId: "price_base_test",
    });
    expect(result.cache.currentPeriodEnd - result.cache.currentPeriodStart).toBe(THIRTY_DAYS_SECONDS);
  });
});

describe("crypto-sub intent CRUD", () => {
  beforeEach(() => clearKVCacheForTests());

  test("newCryptoSubIntent carries the correct shape + 10-min expiry", () => {
    const env = makeEnv();
    const intent = newCryptoSubIntent(env, {
      userId: "user_i",
      plan: "pro",
      priceId: "price_pro_test",
    });
    expect(intent.userId).toBe("user_i");
    expect(intent.customerId).toBe("crypto-user_i");
    expect(intent.plan).toBe("pro");
    expect(intent.status).toBe("pending");
    expect(intent.priceId).toBe("price_pro_test");
    expect(intent.amount).toBe("59");
    expect(intent.currency).toBe("USDC");
    expect(intent.expiresAt - intent.createdAt).toBe(600); // 10 minutes
  });

  test("saveIntent + loadIntent round-trips through KV", async () => {
    const env = makeEnv();
    const intent = newCryptoSubIntent(env, {
      userId: "user_r",
      plan: "base",
      priceId: "price_base_test",
    });
    await saveIntent(env, intent, { ttlSeconds: 600 });

    const loaded = await loadIntent(env, intent.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(intent.id);
    expect(loaded?.plan).toBe("base");
    expect(loaded?.status).toBe("pending");
  });

  test("loadIntent returns null for unknown id", async () => {
    const env = makeEnv();
    const loaded = await loadIntent(env, "not_a_real_id");
    expect(loaded).toBeNull();
  });
});

describe("crypto-sub end-to-end: intent → pay → activate", () => {
  beforeEach(() => clearKVCacheForTests());

  test("full happy path: clean user → intent → activate → conflict detected on re-attempt", async () => {
    const env = makeEnv();
    const userId = "user_e2e";

    // 1. No conflict initially
    expect(await assertNoStripeConflict(env, userId)).toBeNull();

    // 2. Create intent
    const priceId = priceIdForPlan(env, "pro")!;
    const intent = newCryptoSubIntent(env, { userId, plan: "pro", priceId });
    await saveIntent(env, intent, { ttlSeconds: 600 });
    expect(intent.status).toBe("pending");

    // 3. Activate
    const result = await activateCryptoSubscription(env, {
      userId,
      plan: "pro",
      priceId,
    });
    expect(result.cache.status).toBe("active");

    // 4. Re-attempt → conflict
    const conflict = await assertNoStripeConflict(env, userId);
    expect(conflict?.kind).toBe("crypto_sub_active");
  });
});
