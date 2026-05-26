/**
 * Search route x402 gating — Flex envelope (v6.16, Day-5).
 *
 * v6.16 swap: search routes now emit `scheme: @faremeter/flex` for the 402
 * envelope when an authenticated agent has full Flex onboarding. The route
 * is fronted by `requireSignedClient` which only admits the admin key (or
 * agents that pass a signed release manifest) — so non-admin paths require
 * full manifest-header plumbing the original tests never exercised.
 *
 * The admin path bypasses `requireSignedClient` but admin has no agent
 * profile, so `respondWithFlexTerms` returns `flex_escrow_required` rather
 * than a Flex envelope — which is the right behaviour (admin runs without
 * a paired wallet).
 *
 * Free-mode (PAYMENTS_ENABLED=false or X402_SEARCH_ENABLED=false) bypasses
 * payment entirely — unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { searchRoutes } from "../src/routes/search.js";
import { clearKVCacheForTests } from "../src/services/kv.js";
import type { Env } from "../src/types.js";

const PLATFORM_USDC_ATA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const BASE_ENV: Env = {
  API_KEY: "test-api-key",
  EMERGENTDB_API_KEY: "test-emergent",
  NEBIUS_API_KEY: "test-nebius",
  STATS_KV: {} as KVNamespace,
  ENVIRONMENT: "local-dev",
  PAYMENT_RECIPIENT: "0xfeedfacefeedfacefeedfacefeedfacefeedface",
  FLEX_PLATFORM_RECIPIENT_USDC_ATA: PLATFORM_USDC_ATA,
  FLEX_REFUND_TIMEOUT_SLOTS: "150",
  // PR #815: indexing mode is the default. This suite specifically tests the
  // PAID search admission path; opt in here. The "search free when payments
  // disabled" test below overrides to "false" inline.
  PAYMENTS_ENABLED: "true",
  X402_SEARCH_ENABLED: "true",
};

describe("search route x402 gating — Flex envelope (v6.16)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearKVCacheForTests();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/qdkv/get/")) {
        return new Response(JSON.stringify({ found: false, value: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("admin path: returns flex_escrow_required since admin has no agent profile", async () => {
    // Admin key bypasses bearerAuth + requireSignedClient. respondWithFlexTerms
    // checks agentId !== "__admin__" before doing the agent-profile lookup, so
    // admin falls through to the defensive guard which emits
    // `flex_escrow_required` (no escrow PDA to build an authorization against).
    const res = await searchRoutes.request("http://localhost/search", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BASE_ENV.API_KEY}` },
      body: JSON.stringify({ intent: "search packages", k: 5 }),
    }, BASE_ENV);

    const body = await res.json() as { error: string };
    expect(res.status).toBe(402);
    expect(body.error).toBe("flex_escrow_required");
    expect(res.headers.get("X-Flex-Onboarding-Required")).toBe("1");
  });

  it("keeps search free when payments are disabled (PAYMENTS_ENABLED=false)", async () => {
    const res = await searchRoutes.request("http://localhost/search", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BASE_ENV.API_KEY}` },
      body: JSON.stringify({ intent: "search packages", k: 5 }),
    }, { ...BASE_ENV, PAYMENTS_ENABLED: "false" });

    const body = await res.json() as { results: unknown[] };
    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(res.headers.get("X-Unbrowse-Cost-Uc")).toBeNull();
  });

  it("keeps discovery free when X402_SEARCH_ENABLED=false", async () => {
    const res = await searchRoutes.request("http://localhost/search", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BASE_ENV.API_KEY}` },
      body: JSON.stringify({ intent: "search packages", k: 5 }),
    }, { ...BASE_ENV, X402_SEARCH_ENABLED: "false" });

    const body = await res.json() as { results: unknown[] };
    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(res.headers.get("X-Unbrowse-Cost-Uc")).toBeNull();
  });
});
