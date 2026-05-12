/**
 * Falsifier F1 sentinel — anonymous x402 path must remain unchanged when
 * Stripe is not configured. The plan's most important invariant: adding the
 * subscription rail must NEVER break the existing wallet flow.
 *
 * This test exercises subscriptionAdmits() with NO Stripe env vars set and
 * asserts it returns a non-admitting result (or fails closed). Any future
 * change that lets an unconfigured Stripe gate silently admit a real-user
 * request will fail this test — the lost sheep we'd otherwise miss
 * (Luke 15:4).
 */

import { describe, expect, it } from "bun:test";
import { subscriptionAdmits } from "../src/services/stripe.js";
import type { Env } from "../src/types.js";

const NO_STRIPE_ENV = {
  API_KEY: "test",
  EMERGENTDB_API_KEY: "test",
  NEBIUS_API_KEY: "test",
  STATS_KV: {} as KVNamespace,
  TURBOBOX_URL: "https://turbo.test",
  R2_BUCKET: {} as R2Bucket,
  FAL_KEY: "test",
  // explicitly: NO STRIPE_SECRET_KEY, NO DATABASE_URL
} as unknown as Env;

function ctx(vars: { agent_id?: string; user_id?: string }) {
  const state = new Map<string, unknown>(Object.entries(vars));
  return {
    get: (key: string) => state.get(key),
    set: (key: string, value: unknown) => state.set(key, value),
  } as unknown as Parameters<typeof subscriptionAdmits>[1];
}

describe("F1 sentinel — unconfigured Stripe must NOT silently admit", () => {
  it("anonymous request (no user_id, no admin) → no_user (admit=false)", async () => {
    const r = await subscriptionAdmits(NO_STRIPE_ENV, ctx({ agent_id: "anon" }));
    expect(r.admit).toBe(false);
    expect(r.reason).toBe("no_user");
  });

  it("real authenticated user, no Stripe configured → either admit=false OR throws", async () => {
    // Acceptable: {admit:false, reason in [no_sub, no_user, ...]} OR thrown config error.
    // FORBIDDEN: {admit:true} — that would be the silent-admit bug F1 guards against.
    try {
      const r = await subscriptionAdmits(NO_STRIPE_ENV, ctx({ agent_id: "k", user_id: "u" }));
      expect(r.admit).toBe(false);
      expect(r.reason).not.toBe("admit_quota");
      expect(r.reason).not.toBe("admit_overage");
      expect(r.reason).not.toBe("admit_admin");
    } catch (err) {
      const msg = (err as Error).message;
      // configuration errors are an acceptable fail-closed outcome
      expect(msg).toMatch(/STRIPE_SECRET_KEY|DATABASE_URL|EMERGENTDB_API_KEY|required|configured/i);
    }
  });

  it("admin path still admits (escape hatch unchanged)", async () => {
    const r = await subscriptionAdmits(NO_STRIPE_ENV, ctx({ agent_id: "__admin__" }));
    expect(r.admit).toBe(true);
    expect(r.reason).toBe("admit_admin");
  });
});
