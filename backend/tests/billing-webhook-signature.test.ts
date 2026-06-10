/**
 * Stripe webhook signature verification — priority-1 gap from
 * docs/architecture/TEST-SPECS.md §4 (AC-STR-2).
 *
 * Real crypto, no SDK mocks: we sign payloads with Web Crypto HMAC-SHA256
 * exactly as Stripe does (`t=<ts>,v1=<hex(hmac("<ts>.<body>"))>`), then
 * assert verifyWebhookSignature accepts only genuine, fresh, untampered
 * signatures — and that processBillingEvent drops non-allow-listed event
 * types before touching any state.
 */
import { describe, expect, it } from "bun:test";
import {
  verifyWebhookSignature,
  processBillingEvent,
} from "../src/services/stripe.js";
import type { Env } from "../src/types.js";

const WEBHOOK_SECRET = "whsec_test_signature_gate_secret";

const ENV = {
  STRIPE_SECRET_KEY: "sk_test_dummy_key_for_local_hmac_only",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
} as unknown as Env;

async function stripeSign(
  body: string,
  opts: { secret?: string; timestamp?: number } = {},
): Promise<string> {
  const secret = opts.secret ?? WEBHOOK_SECRET;
  const t = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${t}.${body}`),
  );
  const v1 = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${t},v1=${v1}`;
}

const EVENT_BODY = JSON.stringify({
  id: "evt_test_1",
  type: "customer.subscription.updated",
  data: { object: { customer: "cus_test_1" } },
});

describe("verifyWebhookSignature (AC-STR-2 signature gate)", () => {
  it("accepts a genuinely signed payload and returns the parsed event", async () => {
    const sig = await stripeSign(EVENT_BODY);
    const event = await verifyWebhookSignature(ENV, EVENT_BODY, sig);
    expect(event.type).toBe("customer.subscription.updated");
  });

  it("rejects a garbage signature header", async () => {
    await expect(
      verifyWebhookSignature(ENV, EVENT_BODY, "t=123,v1=deadbeef"),
    ).rejects.toThrow();
  });

  it("rejects a tampered body (signature from a different payload)", async () => {
    const sig = await stripeSign(EVENT_BODY);
    const tampered = EVENT_BODY.replace("cus_test_1", "cus_attacker");
    await expect(verifyWebhookSignature(ENV, tampered, sig)).rejects.toThrow();
  });

  it("rejects a signature made with the wrong secret", async () => {
    const sig = await stripeSign(EVENT_BODY, { secret: "whsec_wrong_secret" });
    await expect(verifyWebhookSignature(ENV, EVENT_BODY, sig)).rejects.toThrow();
  });

  it("rejects a stale timestamp outside Stripe's replay tolerance", async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600; // 1h old > 300s default
    const sig = await stripeSign(EVENT_BODY, { timestamp: stale });
    await expect(verifyWebhookSignature(ENV, EVENT_BODY, sig)).rejects.toThrow();
  });

  it("fails closed when STRIPE_WEBHOOK_SECRET is unconfigured", async () => {
    const sig = await stripeSign(EVENT_BODY);
    const bare = { ...ENV, STRIPE_WEBHOOK_SECRET: undefined } as unknown as Env;
    await expect(verifyWebhookSignature(bare, EVENT_BODY, sig)).rejects.toThrow(
      /STRIPE_WEBHOOK_SECRET/,
    );
  });
});

describe("processBillingEvent allow-list (AC-STR-2 negative lane)", () => {
  // The env deliberately has NO KV/DB bindings: if the early returns ever
  // stop firing, these calls would throw on the missing bindings and the
  // test would fail — proving the guard, not assuming it.
  const bareEnv = {
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  } as unknown as Env;

  it("ignores event types outside the allow-list without touching state", async () => {
    await expect(
      processBillingEvent(bareEnv, {
        id: "evt_x",
        type: "balance.available", // not in the 19-event allow-list
        data: { object: { customer: "cus_test_1" } },
      } as Parameters<typeof processBillingEvent>[1]),
    ).resolves.toBeUndefined();
  });

  it("ignores allow-listed events that carry no customer id", async () => {
    await expect(
      processBillingEvent(bareEnv, {
        id: "evt_y",
        type: "customer.subscription.updated",
        data: { object: {} },
      } as Parameters<typeof processBillingEvent>[1]),
    ).resolves.toBeUndefined();
  });
});
