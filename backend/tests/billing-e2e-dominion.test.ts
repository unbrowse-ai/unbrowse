/**
 * Day 6 (Dominion) — end-to-end exercise across every seam.
 *
 * Hits the mounted billing routes via Hono's request() directly. Proves the
 * gate / routes / service / KV / Neon seams hold together under realistic
 * conditions (no Stripe secret configured → endpoints must fail closed with
 * structured errors, NOT silent admits or stack traces).
 *
 * NOTE: billingRoutes is a Hono sub-app; routes are defined at "/billing/*".
 * When mounted in src/index.ts via `app.route("/v1", billingRoutes)` they
 * become "/v1/billing/*". For direct sub-app requests, drop the "/v1" prefix.
 */

import { describe, expect, it } from "bun:test";
import { billingRoutes } from "../src/routes/billing.js";
import type { Env } from "../src/types.js";

const BARE_ENV = {
  API_KEY: "test-admin",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "test",
  STATS_KV: {} as KVNamespace,
  TURBOBOX_URL: "https://t",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "test",
} as unknown as Env;

describe("E2E — POST /billing/webhook", () => {
  it("rejects request with no stripe-signature header (400)", async () => {
    const r = await billingRoutes.request(
      "http://test/billing/webhook",
      { method: "POST", body: "{}" },
      BARE_ENV,
    );
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe("missing_signature");
  });

  it("rejects request with bad signature even when present (400)", async () => {
    const r = await billingRoutes.request(
      "http://test/billing/webhook",
      {
        method: "POST",
        body: '{"type":"customer.subscription.created"}',
        headers: { "stripe-signature": "t=1,v1=garbage" },
      },
      BARE_ENV,
    );
    expect(r.status).toBe(400);
  });
});

describe("E2E — auth-gated routes reject anonymous callers", () => {
  for (const [method, path] of [
    ["GET", "/billing/me"],
    ["POST", "/billing/checkout"],
    ["GET", "/billing/portal"],
    ["GET", "/billing/success"],
  ] as const) {
    it(`${method} ${path} without bearer → 401`, async () => {
      const r = await billingRoutes.request(
        `http://test${path}`,
        { method, body: method === "POST" ? "{}" : undefined },
        BARE_ENV,
      );
      expect([401, 403]).toContain(r.status);
    });
  }
});
