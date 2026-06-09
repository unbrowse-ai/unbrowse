/**
 * /v1/search/web — unbrowse's own keyless web search, owner-vs-x402 routing.
 *
 *   - Owner ("__admin__" via the master API key) → runs free (no 402, no payment).
 *   - External caller (no/other key, no payment) → x402: 402 Payment Required.
 *   - Missing query → 400.
 *
 * No vendor key: the search runs DuckDuckGo HTML retrieval from the Worker. The
 * DDG HTTP call is mocked via global fetch; the routing decision + the keyless
 * parse are what this suite verifies (Flex settlement reuses already-tested paths).
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
};

// A minimal DuckDuckGo HTML payload matching the webSearch parser (result__a
// anchor with a uddg-wrapped href, plus a result__snippet).
const DDG_HTML = `<div class="result">
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=x">Example A</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">A snippet about agents.</a>
</div>`;

describe("/search/web — owner-vs-x402 routing (keyless)", () => {
  const originalFetch = globalThis.fetch;
  let webCalls: Array<{ query: string }>;

  beforeEach(() => {
    clearKVCacheForTests();
    webCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("duckduckgo.com")) {
        const q = new URL(url).searchParams.get("q") ?? "";
        webCalls.push({ query: q });
        return new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      // KV / cache / sponsor / subscription lookups → benign empty.
      return new Response(JSON.stringify({ found: false, value: null, results: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("owner (admin key) → free keyless web search, no payment, results parsed", async () => {
    const res = await searchRoutes.request("http://localhost/search/web", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BASE_ENV.API_KEY}` },
      body: JSON.stringify({ query: "best ai agents", k: 3 }),
    }, BASE_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { query: string; results: Array<{ url: string; title?: string; highlights?: string[] }> };
    expect(body.results.length).toBe(1);
    expect(body.results[0]?.url).toBe("https://example.com/a"); // uddg unwrapped
    expect(body.results[0]?.title).toBe("Example A");
    expect(body.results[0]?.highlights?.[0]).toContain("snippet");
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(webCalls.length).toBe(1);
    expect(webCalls[0]?.query).toBe("best ai agents");
  });

  it("external caller (no payment) → 402, web search is NOT called", async () => {
    const res = await searchRoutes.request("http://localhost/search/web", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "best ai agents" }),
    }, BASE_ENV);

    expect(res.status).toBe(402);
    expect(webCalls.length).toBe(0); // gated before the priced web call
  });

  it("missing query → 400", async () => {
    const res = await searchRoutes.request("http://localhost/search/web", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BASE_ENV.API_KEY}` },
      body: JSON.stringify({ k: 3 }),
    }, BASE_ENV);
    expect(res.status).toBe(400);
  });
});
