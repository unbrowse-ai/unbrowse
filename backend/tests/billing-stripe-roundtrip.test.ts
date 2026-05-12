/**
 * Real Stripe-test-mode round-trip — A2 from the plan.
 *
 * CLAUDE.md "no mocks": this test hits real Stripe test mode when the env
 * gate is set, otherwise skips loudly (so CI doesn't silently bypass the
 * signal). It is the storm that tests the foundation (Matt 7:24-25).
 *
 *   STRIPE_TEST_SECRET_KEY=sk_test_... \
 *   STRIPE_TEST_PRICE_BASE=price_test_... \
 *   bun test backend/tests/billing-stripe-roundtrip.test.ts
 */

import { describe, expect, it, beforeAll } from "bun:test";
import {
  getOrCreateCustomer,
  syncStripeDataToUserKV,
  createCheckoutSession,
  readSubFromKV,
} from "../src/services/stripe.js";
import type { Env } from "../src/types.js";

const STRIPE_TEST_SECRET_KEY = process.env.STRIPE_TEST_SECRET_KEY;
const STRIPE_TEST_PRICE_BASE = process.env.STRIPE_TEST_PRICE_BASE;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ENABLED = !!STRIPE_TEST_SECRET_KEY && !!STRIPE_TEST_PRICE_BASE && !!TEST_DATABASE_URL;

const TEST_ENV: Env = {
  API_KEY: "test",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "test",
  STATS_KV: {} as KVNamespace,
  TURBOBOX_URL: "https://turbo.test",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "test",
  STRIPE_SECRET_KEY: STRIPE_TEST_SECRET_KEY ?? "",
  STRIPE_PRICE_BASE: STRIPE_TEST_PRICE_BASE ?? "",
  DATABASE_URL: TEST_DATABASE_URL ?? "",
  PUBLIC_FRONTEND_URL: "https://test.unbrowse.ai",
} as unknown as Env;

describe("Stripe round-trip (real test mode, gated by env)", () => {
  beforeAll(() => {
    if (!ENABLED) {
      console.warn(
        "[skip] STRIPE_TEST_SECRET_KEY / STRIPE_TEST_PRICE_BASE / TEST_DATABASE_URL not set — skipping real round-trip.",
      );
    }
  });

  it("creates a customer once, returns same id on repeat (idempotent)", async () => {
    if (!ENABLED) return;
    const userId = `jl-test-${Date.now()}`;
    const email = `${userId}@example.test`;
    const id1 = await getOrCreateCustomer(TEST_ENV, userId, email);
    const id2 = await getOrCreateCustomer(TEST_ENV, userId, email);
    expect(id1).toBe(id2);
    expect(id1.startsWith("cus_")).toBe(true);
  }, 30_000);

  it("syncStripeDataToUserKV on a fresh customer returns status:none and persists it", async () => {
    if (!ENABLED) return;
    const userId = `jl-test-${Date.now()}-empty`;
    const customerId = await getOrCreateCustomer(TEST_ENV, userId, `${userId}@example.test`);
    const sub = await syncStripeDataToUserKV(TEST_ENV, customerId);
    expect(sub.status).toBe("none");
    const cached = await readSubFromKV(TEST_ENV, userId);
    expect(cached?.status).toBe("none");
  }, 30_000);

  it("createCheckoutSession returns a checkout.stripe.com URL", async () => {
    if (!ENABLED) return;
    const userId = `jl-test-${Date.now()}-checkout`;
    const { url } = await createCheckoutSession(
      TEST_ENV,
      userId,
      `${userId}@example.test`,
      "https://test.unbrowse.ai/billing/success",
    );
    expect(url).toMatch(/checkout\.stripe\.com/);
  }, 30_000);
});
