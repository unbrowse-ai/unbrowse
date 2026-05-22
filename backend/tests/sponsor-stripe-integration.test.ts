/**
 * Contract 9474c6ab — sponsor middleware Stripe-admission integration.
 *
 * Four cases verify the gated, non-regressing wiring:
 *   A. UNBROWSE_BILLING_ENABLED unset → maybeSponsor takes the legacy path
 *      (no Stripe import attempted, decision is exhausted{no_wallet}
 *      because no PLATFORM_SPONSOR_WALLET_KEY is set).
 *   B. UNBROWSE_BILLING_ENABLED=1 with no subscription cache row → falls
 *      through to the legacy platform-sponsor path (same exhausted decision).
 *   C. UNBROWSE_BILLING_ENABLED=1 + active subscription seeded → returns
 *      `{ kind: "sponsored", method: "stripe" }`. Requires TEST_DATABASE_URL
 *      (peekUsage needs Neon); honest-skipped when unavailable.
 *   D. Opt-out header still wins even when the gate is on.
 *
 * No mocks of the unit under test; we hit the real `maybeSponsor` and write
 * the same KV keys `subscriptionAdmits` reads.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetSponsorMiddlewareStateForTests,
  maybeSponsor,
} from "../src/middleware/sponsor.js";
import type { X402PaymentRequirementV2 } from "../src/middleware/x402-gate.js";
import type { Env } from "../src/types.js";
import { LocalKV, clearKVCacheForTests } from "../src/services/kv.js";

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

function makeEnv(opts: {
  billingEnabled?: boolean;
  withWallet?: boolean;
  databaseUrl?: string;
}): Env {
  return {
    API_KEY: "test-api-key",
    EMERGENTDB_API_KEY: "x",
    NEBIUS_API_KEY: "x",
    TURBOBOX_URL: "x",
    FAL_KEY: "x",
    R2_BUCKET: {} as R2Bucket,
    STATS_KV: makeMemoryKv(),
    ENVIRONMENT: "local-dev",
    PAYMENTS_ENABLED: "true",
    PLATFORM_SPONSOR_WALLET_ADDRESS: opts.withWallet
      ? "So1PlatformWallet1111111111111111111111111111"
      : undefined,
    PLATFORM_SPONSOR_WALLET_KEY: opts.withWallet ? "deadbeef" : undefined,
    UNBROWSE_BILLING_ENABLED: opts.billingEnabled ? "1" : undefined,
    DATABASE_URL: opts.databaseUrl,
  } as Env;
}

function makeContext(
  env: Env,
  opts?: { url?: string; headers?: Record<string, string>; userId?: string },
): Parameters<typeof maybeSponsor>[0] {
  const url = opts?.url ?? "http://localhost/v1/skills/skill-test";
  const headers = opts?.headers ?? {};
  const vars: Record<string, unknown> = {};
  if (opts?.userId) vars.user_id = opts.userId;
  return {
    env,
    req: {
      header: (name: string) => headers[name],
      url,
    },
    get: (key: string) => vars[key],
    set: (key: string, value: unknown) => {
      vars[key] = value;
    },
  } as unknown as Parameters<typeof maybeSponsor>[0];
}

const STD_TERMS: X402PaymentRequirementV2[] = [
  {
    scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    amount: "1000",
    asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    payTo: "So1Creator9999999999999999999999999999999999",
    maxTimeoutSeconds: 300,
  },
];

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

beforeEach(() => {
  _resetSponsorMiddlewareStateForTests();
  clearKVCacheForTests("stats");
});

describe("contract 9474c6ab — sponsor middleware Stripe integration is gated and non-regressing", () => {
  test("A. UNBROWSE_BILLING_ENABLED unset: legacy path unchanged (exhausted{no_wallet})", async () => {
    const env = makeEnv({ billingEnabled: false, withWallet: false });
    const c = makeContext(env, { userId: "user-A" });
    const decision = await maybeSponsor(c, STD_TERMS, "agent-A");
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") {
      expect(decision.reason).toBe("no_wallet");
    }
  });

  test("B. UNBROWSE_BILLING_ENABLED=1 + no subscription: falls through to platform sponsor path", async () => {
    // Subscription gate runs, finds no `stripe:user:user-B` mapping, falls
    // through to the legacy wallet check. With no wallet seeded the legacy
    // path returns exhausted{no_wallet}, proving the subscription path did
    // not short-circuit incorrectly.
    const env = makeEnv({ billingEnabled: true, withWallet: false });
    const c = makeContext(env, { userId: "user-B" });
    const decision = await maybeSponsor(c, STD_TERMS, "agent-B");
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") {
      expect(decision.reason).toBe("no_wallet");
    }
  });

  test.skipIf(!TEST_DATABASE_URL)(
    "C. UNBROWSE_BILLING_ENABLED=1 + active subscription seeded in KV: returns sponsored{method:stripe}",
    async () => {
      // Seed the canonical Stripe KV keys that subscriptionAdmits reads:
      //   stripe:user:<userId>           -> customerId
      //   stripe:customer:<customerId>   -> STRIPE_SUB_CACHE JSON
      // No platform sponsor wallet — proves the Stripe lane fires BEFORE the
      // wallet check.
      const userId = `user-C-${crypto.randomUUID()}`;
      const customerId = `cus_TEST_${crypto.randomUUID()}`;
      const subCache = {
        status: "active",
        subscriptionId: "sub_TEST",
        priceId: "price_TEST",
        currentPeriodStart: Math.floor(Date.now() / 1000),
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 86_400 * 30,
        cancelAtPeriodEnd: false,
        paymentMethod: { brand: "visa", last4: "4242" },
        quota: 100_000,
        overageAllowed: false,
        overagePriceId: null,
        updatedAt: Date.now(),
      };
      const localKv = new LocalKV("stats");
      await localKv.put(`stripe:user:${userId}`, customerId);
      await localKv.put(`stripe:customer:${customerId}`, JSON.stringify(subCache));

      const env = makeEnv({
        billingEnabled: true,
        withWallet: false,
        databaseUrl: TEST_DATABASE_URL,
      });
      const c = makeContext(env, { userId });
      const decision = await maybeSponsor(c, STD_TERMS, "agent-C");

      expect(decision.kind).toBe("sponsored");
      if (decision.kind === "sponsored") {
        expect(decision.method).toBe("stripe");
        expect(decision.tx_hash).toMatch(/^stripe:/);
        expect(decision.ledger_id).toMatch(/^str-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}$/);

        const row = (await localKv.get(`sponsor:ledger:${decision.ledger_id}`)) as
          | string
          | null;
        expect(row).not.toBeNull();
        const parsed = JSON.parse(row!) as { payment_method?: string };
        expect(parsed.payment_method).toBe("stripe");
      }
    },
  );

  test("C-fallback. UNBROWSE_BILLING_ENABLED=1 + sub seeded but no DATABASE_URL: gate throws, falls through to legacy path", async () => {
    // Same seed as C, but without TEST_DATABASE_URL the peekUsage call inside
    // subscriptionAdmits throws "DATABASE_URL is required". The outer try/
    // catch in the sponsor middleware must swallow that and fall through to
    // the legacy platform-sponsor path. Verifies the integration NEVER
    // crashes the sponsor decision on a Stripe-side failure.
    const userId = "user-Cf";
    const customerId = "cus_TEST_Cf";
    const subCache = {
      status: "active",
      subscriptionId: "sub_TEST",
      priceId: "price_TEST",
      currentPeriodStart: Math.floor(Date.now() / 1000),
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 86_400 * 30,
      cancelAtPeriodEnd: false,
      paymentMethod: null,
      quota: 100_000,
      overageAllowed: false,
      overagePriceId: null,
      updatedAt: Date.now(),
    };
    const localKv = new LocalKV("stats");
    await localKv.put(`stripe:user:${userId}`, customerId);
    await localKv.put(`stripe:customer:${customerId}`, JSON.stringify(subCache));

    const env = makeEnv({ billingEnabled: true, withWallet: false });
    const c = makeContext(env, { userId });
    const decision = await maybeSponsor(c, STD_TERMS, "agent-Cf");
    expect(decision.kind).toBe("exhausted");
    if (decision.kind === "exhausted") {
      expect(decision.reason).toBe("no_wallet");
    }
  });

  test("D. Opt-out wins even when UNBROWSE_BILLING_ENABLED=1 (opt-out is absolute)", async () => {
    const env = makeEnv({ billingEnabled: true, withWallet: true });
    const c = makeContext(env, {
      userId: "user-D",
      headers: { "X-No-Sponsor": "1" },
    });
    const decision = await maybeSponsor(c, STD_TERMS, "agent-D");
    expect(decision.kind).toBe("opted_out");
  });
});
