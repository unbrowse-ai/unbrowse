/**
 * /v1/search/web — Exa-backed external web search, owner-vs-x402 routing.
 *
 *   - Owner ("__admin__" via the master API key) → runs on the platform's own
 *     Exa key, FREE (no 402, no payment headers).
 *   - External caller (no/other key, no payment) → x402: 402 Payment Required.
 *   - No EXA_API_KEY configured → 503 (feature unavailable).
 *   - Missing query → 400.
 *
 * The Exa HTTP call is mocked via global fetch; the routing decision is what
 * this suite verifies (the live Exa call + Flex settlement reuse already-tested
 * paths).
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
  EXA_API_KEY: "test-exa-key",
};

describe("/search/web — owner-vs-x402 routing", () => {
  const originalFetch = globalThis.fetch;
  let exaCalls: Array<{ apiKey: string | null; query: string }>;

  beforeEach(() => {
    clearKVCacheForTests();
    exaCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.exa.ai")) {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
        exaCalls.push({ apiKey: headers["x-api-key"] ?? null, query: body.query ?? "" });
        return new Response(JSON.stringify({
          results: [{ url: "https://example.com/a", title: "A", score: 0.9, highlights: ["hi"] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
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

  it("owner (admin key) → free Exa search on the platform key, no payment", async () => {
    const res = await searchRoutes.request("http://localhost/search/web", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BASE_ENV.API_KEY}` },
      body: JSON.stringify({ query: "best ai agents", k: 3 }),
    }, BASE_ENV);

    expect(res.status).toBe(200);
    const body = await res.json() as { query: string; results: unknown[] };
    expect(body.results.length).toBe(1);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    // Ran on the platform's own Exa key.
    expect(exaCalls.length).toBe(1);
    expect(exaCalls[0]?.apiKey).toBe("test-exa-key");
    expect(exaCalls[0]?.query).toBe("best ai agents");
  });

  it("external caller (no payment) → 402, Exa is NOT called", async () => {
    const res = await searchRoutes.request("http://localhost/search/web", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "best ai agents" }),
    }, BASE_ENV);

    expect(res.status).toBe(402);
    expect(exaCalls.length).toBe(0); // gated before the paid Exa call
  });

  it("no EXA_API_KEY configured → 503", async () => {
    const env = { ...BASE_ENV, EXA_API_KEY: undefined };
    const res = await searchRoutes.request("http://localhost/search/web", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${BASE_ENV.API_KEY}` },
      body: JSON.stringify({ query: "x" }),
    }, env);
    expect(res.status).toBe(503);
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
