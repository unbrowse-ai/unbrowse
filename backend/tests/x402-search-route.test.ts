/**
 * Search route — always free indexing (PR #816).
 *
 * Previously this test asserted env-var-controlled paid/free admission via
 * `PAYMENTS_ENABLED` / `X402_SEARCH_ENABLED`. PR #816 removed both env
 * escape hatches: search is now ALWAYS free indexing, period. There is no
 * operator-side knob that can flip it into paid mode.
 *
 * What we still test:
 *   - Authenticated admin path → 200 with the search payload (no 402).
 *   - Anonymous/un-signed callers still hit `requireSignedClient`, separate
 *     auth concern from payment; covered by other tests.
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
};

describe("search route — always free indexing (PR #816)", () => {
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

  it("admin path is always free — no Flex envelope, no payment headers", async () => {
    // PR #816: search is indexing — admin (or any) caller gets 200 free.
    // No more `flex_escrow_required` path on search since there is no
    // payment gate to short-circuit.
    const res = await searchRoutes.request("http://localhost/search", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BASE_ENV.API_KEY}` },
      body: JSON.stringify({ intent: "search packages", k: 5 }),
    }, BASE_ENV);

    const body = await res.json() as { results: unknown[] };
    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(res.headers.get("X-Flex-Onboarding-Required")).toBeNull();
    expect(res.headers.get("X-Unbrowse-Cost-Uc")).toBeNull();
  });
});
