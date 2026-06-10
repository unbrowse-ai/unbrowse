import { test, expect, beforeEach, afterEach } from "bun:test";
import { indexEndpoints, searchIntent } from "../src/services/discovery";

// DOMINION (end-to-end across the seam): the north-star path at the code level —
// a skill WRITTEN by indexEndpoints must come BACK from searchIntent on the same
// store. This is the integration the unit tests split apart: write-boundary
// (bm25-idx:v2-global) meeting read-boundary (searchIntent → bm25Search reads
// bm25-idx:v2-global). If the write key and read key disagreed, this fails.

function fakeKV() {
  const m = new Map<string, string>();
  return {
    store: m,
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => { m.set(k, v); },
  };
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  // EmergentDB graph: empty results for /graph/search, ok for /graph/batch_insert.
  // This is the DEGRADED-graph reality — only the BM25/KV path carries the result.
  globalThis.fetch = (async (_url: string) =>
    new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json" } })
  ) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const env = () => ({ STATS_KV: fakeKV(), ENVIRONMENT: "local", EMERGENTDB_API_KEY: "x" }) as never;

test("e2e: a skill indexed by indexEndpoints is returned by searchIntent (graph down)", async () => {
  const e = env();
  await indexEndpoints(e, "skillCheckout",
    [{ endpoint_id: "place", method: "POST", url_template: "https://shop.example/checkout",
       description: "place an order and checkout cart items" }],
    { domain: "shop.example" });

  const results = await searchIntent(e, "checkout place order", 5);
  expect(results.length).toBeGreaterThan(0);                 // the written skill is FINDABLE
  expect(results.map((r) => String(r.id))).toContain("skillCheckout:place");
});

test("e2e: search discriminates — an unrelated query does not surface the skill", async () => {
  const e = env();
  await indexEndpoints(e, "skillWeather",
    [{ endpoint_id: "f", method: "GET", url_template: "https://w.example/forecast",
       description: "get the weather forecast for a city" }],
    { domain: "w.example" });

  // BM25 scores>0 only on term overlap; a totally unrelated intent must not match.
  const results = await searchIntent(e, "purchase airline tickets baggage", 5);
  expect(results.map((r) => String(r.id))).not.toContain("skillWeather:f");
});

test("e2e: two domains indexed, the right one wins for an intent", async () => {
  const e = env();
  await indexEndpoints(e, "skillFlights",
    [{ endpoint_id: "s", method: "GET", url_template: "https://air.example/search",
       description: "search available flights between airports by date" }],
    { domain: "air.example" });
  await indexEndpoints(e, "skillHotels",
    [{ endpoint_id: "s", method: "GET", url_template: "https://stay.example/search",
       description: "search hotels and rooms by city and check-in date" }],
    { domain: "stay.example" });

  const flights = await searchIntent(e, "find flights between airports", 5);
  expect(String(flights[0]?.id)).toBe("skillFlights:s");     // top hit is the flights skill
});
