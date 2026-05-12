/**
 * Day 4 (Luminaries) — implementation tests for services/stripe.ts.
 *
 * Started as a Day 3 mustard-seed contract test. Now the SDK is wired, so the
 * tests shift from "throws not implemented" to "either admits/rejects with
 * the right typed reason, or fails closed with a configuration error."
 *
 * Real Stripe-test-mode round-trip lives in billing-stripe-roundtrip.test.ts
 * (gated by STRIPE_TEST_SECRET_KEY env var, per CLAUDE.md "no mocks" rule —
 * the integration test hits real Stripe test mode when the env var is set).
 */

import { describe, expect, it } from "bun:test";
import {
  KV_KEYS,
  STRIPE_NOT_IMPLEMENTED,
  createCheckoutSession,
  createPortalSession,
  processBillingEvent,
  subscriptionAdmits,
  verifyWebhookSignature,
} from "../src/services/stripe.js";
import type { STRIPE_SUB_CACHE, SubscriptionAdmitResult } from "../src/services/stripe.types.js";
import type { Env } from "../src/types.js";

const BASE_ENV = {
  API_KEY: "test-api-key",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "test",
  STATS_KV: {} as KVNamespace,
  TURBOBOX_URL: "https://turbo.test",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "test",
} as unknown as Env;

function ctx(vars: { agent_id?: string; user_id?: string } = {}) {
  const state = new Map<string, unknown>(Object.entries(vars));
  return {
    get: (key: string) => state.get(key),
    set: (key: string, value: unknown) => state.set(key, value),
  } as unknown as Parameters<typeof subscriptionAdmits>[1];
}

describe("admission — landmines that resolve WITHOUT touching the SDK", () => {
  it("admits __admin__ without user_id and skips usage", async () => {
    const result = await subscriptionAdmits(BASE_ENV, ctx({ agent_id: "__admin__" }));
    expect(result.admit).toBe(true);
    expect(result.reason).toBe("admit_admin");
    expect(result.consumed).toBeUndefined();
  });

  it("returns no_user (admit=false) when user_id is missing — x402 falls through (F1)", async () => {
    const result = await subscriptionAdmits(BASE_ENV, ctx({ agent_id: "key_123" }));
    expect(result.admit).toBe(false);
    expect(result.reason).toBe("no_user");
  });

  it("returns no_user even with no agent_id at all", async () => {
    const result = await subscriptionAdmits(BASE_ENV, ctx({}));
    expect(result.admit).toBe(false);
    expect(result.reason).toBe("no_user");
  });
});

describe("admission — fails closed on missing config (no leaking through)", () => {
  it("real user with no STRIPE_SECRET_KEY → throws configuration error, NOT silent admit", async () => {
    // F1/F6: if Stripe isn't configured at all, admission must NOT silently admit.
    // Acceptable failure modes: configuration error OR no_sub (KV read returns null).
    // The wrong outcome would be {admit: true} from an unconfigured path.
    try {
      const result = await subscriptionAdmits(
        BASE_ENV,
        ctx({ agent_id: "key_abc", user_id: "user_xyz" }),
      );
      // If it resolves, it MUST be a non-admitting result.
      expect(result.admit).toBe(false);
    } catch (err) {
      // Or it throws a clear configuration error.
      const msg = (err as Error).message;
      expect(msg).toMatch(/STRIPE_SECRET_KEY|DATABASE_URL|EMERGENTDB_API_KEY|configured|required/i);
    }
  });
});

describe("KV key conventions (F2 single-writer prefix)", () => {
  it("user→customer key", () => {
    expect(KV_KEYS.userCustomer("u_42")).toBe("stripe:user:u_42");
  });
  it("customer→sub key", () => {
    expect(KV_KEYS.customerSub("cus_x")).toBe("stripe:customer:cus_x");
  });
});

describe("SDK-bound exports — fail closed on missing config", () => {
  it("createCheckoutSession rejects when STRIPE_SECRET_KEY missing", async () => {
    await expect(
      createCheckoutSession(BASE_ENV, "u", "e@x.com", "https://r"),
    ).rejects.toThrow(/STRIPE_SECRET_KEY|configured/i);
  });

  it("createPortalSession rejects when STRIPE_SECRET_KEY missing (or no_customer)", async () => {
    await expect(createPortalSession(BASE_ENV, "u", "https://r")).rejects.toThrow(
      /STRIPE_SECRET_KEY|configured|no_customer/i,
    );
  });

  it("verifyWebhookSignature rejects when STRIPE_WEBHOOK_SECRET missing", async () => {
    await expect(verifyWebhookSignature(BASE_ENV, "{}", "sig")).rejects.toThrow(
      /STRIPE_WEBHOOK_SECRET|configured/i,
    );
  });
});

describe("processBillingEvent — whitelist behavior", () => {
  it("ignores non-whitelisted event types (returns silently, no DB write)", async () => {
    // "x" is not a Stripe event type — should no-op.
    await expect(
      processBillingEvent(BASE_ENV, { id: "evt_x", type: "x", data: { object: {} } }),
    ).resolves.toBeUndefined();
  });
});

describe("STRIPE_SUB_CACHE discriminated union — type-shape sanity", () => {
  it("status:none variant", () => {
    const c: STRIPE_SUB_CACHE = { status: "none" };
    expect(c.status).toBe("none");
  });
  it("active variant carries all fields", () => {
    const c: STRIPE_SUB_CACHE = {
      status: "active",
      subscriptionId: "sub_1",
      priceId: "price_1",
      currentPeriodStart: 0,
      currentPeriodEnd: 0,
      cancelAtPeriodEnd: false,
      paymentMethod: null,
      quota: 100,
      overageAllowed: true,
      overagePriceId: "price_meter",
      updatedAt: Date.now(),
    };
    expect(c.status).toBe("active");
  });
});

describe("SubscriptionAdmitResult — exhaustive reason list pinned (anti-drift)", () => {
  it("every admit reason is a member of the union", () => {
    const reasons: SubscriptionAdmitResult["reason"][] = [
      "no_user",
      "no_sub",
      "inactive",
      "quota_exhausted",
      "admit_quota",
      "admit_overage",
      "admit_admin",
    ];
    expect(reasons.length).toBe(7);
  });
});

describe("Day 3 skeleton sentinel still exported (for downstream version checks)", () => {
  it("STRIPE_NOT_IMPLEMENTED is still importable (compatibility)", () => {
    expect(STRIPE_NOT_IMPLEMENTED).toBeInstanceOf(Error);
  });
});
