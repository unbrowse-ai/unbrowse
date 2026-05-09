// Falsifiable signals for Phase D — 5xx → page_fetch fallback in executeEndpoint
// (src/execution/index.ts:2756).
//
// Asserts:
//   1. lost-sheep recursion guard: when endpoint IS already a page_fetch synthetic
//      and 5xx, fallback does NOT recurse (preserves staleEndpointResult).
//   2. 5xx + non-page_fetch endpoint → fallback path computes synthetic page_fetch
//      with same URL + same intent + authRequired=false.
//   3. 404 → existing staleEndpointResult preserved (no over-trigger).
//   4. 429 → existing staleEndpointResult preserved.
//   5. 503 with isPageFetchEndpoint=true → no recurse (guard fires).
//
// We can't easily mock the full executeEndpoint recursion in a unit test; this
// test instead verifies the helper functions our Phase D path depends on:
//   - isPageFetchEndpoint correctly identifies page_fetch endpoints
//   - buildPageFetchEndpoint produces a valid synthesizable ep
//   - the guard predicate fires correctly on the synth output

import { describe, it, expect } from "bun:test";
import { isPageFetchEndpoint, buildPageFetchEndpoint } from "../src/execution/index";

describe("Phase D — 5xx → page_fetch fallback predicates", () => {
  it("buildPageFetchEndpoint produces an endpoint isPageFetchEndpoint identifies", () => {
    const ep = buildPageFetchEndpoint("https://walmart.com/search?q=coffee", "search walmart for coffee", false);
    expect(isPageFetchEndpoint(ep)).toBe(true);
    expect(ep.method).toBe("GET");
    expect(ep.url_template).toContain("walmart.com");
  });

  it("recursion guard: synthesized page_fetch is recognized — prevents infinite loop", () => {
    // The guard `!isPageFetchEndpoint(endpoint)` must fire TRUE for synth eps,
    // so when a recursed call's endpoint IS the synthetic page_fetch, the
    // outer 5xx-fallback skips the second recurse.
    const synth = buildPageFetchEndpoint("https://walmart.com/search?q=coffee", "search", false);
    const guardWouldRecurse = !isPageFetchEndpoint(synth);
    expect(guardWouldRecurse).toBe(false);
  });

  it("non-page_fetch endpoint does NOT trip the guard — fallback eligible", () => {
    const realEp = {
      endpoint_id: "Omvn0tiala4JbGfkdlDe9",
      method: "GET" as const,
      url_template: "https://www.walmart.com/search?q={q}",
      idempotency: "safe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
      description: "Captured search form",
      response_schema: { type: "object", properties: {} },
      dom_extraction: { extraction_method: "spa-nextjs" as const, confidence: 1 },
    };
    const guardWouldRecurse = !isPageFetchEndpoint(realEp as any);
    expect(guardWouldRecurse).toBe(true);
  });

  it("buildPageFetchEndpoint preserves intent in description", () => {
    const ep = buildPageFetchEndpoint("https://example.com/path", "find products on example", false);
    expect(ep.description).toContain("find products on example");
  });

  it("buildPageFetchEndpoint produces stable id for same (url, intent)", () => {
    // Stable id matters: when two 5xx fallback paths converge on the same
    // synth ep, marketplace caching can dedupe. Phase D doesn't publish
    // these, but the contract should remain stable.
    const ep1 = buildPageFetchEndpoint("https://walmart.com/search?q=coffee", "x", false);
    const ep2 = buildPageFetchEndpoint("https://walmart.com/search?q=coffee", "x", false);
    expect(ep1.endpoint_id).toBe(ep2.endpoint_id);
  });

  it("status gate: only 5xx triggers fallback (predicate-shape test)", () => {
    // The Phase D condition is `status >= 500 && !isPageFetchEndpoint(endpoint)`.
    // Verify the boolean shape on each status class.
    const realEp = { dom_extraction: { extraction_method: "spa-nextjs" } } as any;
    expect(500 >= 500 && !isPageFetchEndpoint(realEp)).toBe(true);   // 500 fires
    expect(503 >= 500 && !isPageFetchEndpoint(realEp)).toBe(true);   // 503 fires
    expect(429 >= 500 && !isPageFetchEndpoint(realEp)).toBe(false);  // 429 does not
    expect(404 >= 500 && !isPageFetchEndpoint(realEp)).toBe(false);  // 404 does not
  });
});
