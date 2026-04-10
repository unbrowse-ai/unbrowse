// Regression probes for the three extractor bypasses added after the
// bench-local zillow investigation (2026-04-11). Each asserts that a
// request which *used* to be silently dropped is now admitted.
//
// If any of these break, a future edit has regressed a concrete site:
//   - semantic_graphql_bypass → zillow.com/graphql/ and every other SPA
//   - sibling-domain unblock  → zillowstatic.com assets paired with zillow.com
//   - SPA data-fetch URL      → zillow.com/async-create-search-page-state

import { describe, expect, it } from "bun:test";
import { extractEndpoints } from "../src/reverse-engineer/index.js";
import type { RawRequest } from "../src/capture/index.js";

function req(overrides: Partial<RawRequest>): RawRequest {
  return {
    url: "https://www.zillow.com/graphql/",
    method: "POST",
    request_headers: { "content-type": "application/json" },
    request_body: JSON.stringify({ operationName: "SearchListings", variables: {}, query: "query SearchListings { listings { id price address bedrooms } }" }),
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify({ data: { listings: [{ id: "1", price: 1_200_000, address: "1 Main St", bedrooms: 3 }] } }),
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("extractor filter bypasses (regression probes)", () => {
  it("admits /graphql/ endpoints even when URL tokens don't match the intent entity kind", () => {
    // Intent is 'get zillow listing' → inferIntentEntityKind returns 'listing',
    // whose strong tokens are listing/listings/price/seller/currency/product.
    // A generic graphql URL path has none of those tokens. Pre-fix this would
    // return 0 endpoints via semantic_entity_mismatch. Post-fix it admits
    // via semantic_graphql_bypass and lets operationName disambiguate.
    const endpoints = extractEndpoints(
      [req({})],
      undefined,
      { pageUrl: "https://www.zillow.com/homes/for_sale/San-Francisco-CA/", intent: "get zillow listing" },
    );
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
    expect(endpoints[0]?.url_template).toContain("graphql");
  });

  it("admits sibling-subdomain data json (zillow.com ↔ zillowstatic.com)", () => {
    // A .json data endpoint on zillowstatic.com used to be dropped as
    // domain_mismatch because registrable domains differ (zillow.com vs
    // zillowstatic.com). Post-fix the brand-prefix sibling rule admits it.
    // Response carries real listing tokens so semantic gating passes.
    const endpoints = extractEndpoints(
      [req({
        url: "https://www.zillowstatic.com/s3/data/listings.json",
        method: "GET",
        request_body: undefined,
        response_body: JSON.stringify({
          listings: [
            { id: "1", price: 1_200_000, seller: "Agent", currency: "USD", product: "condo" },
            { id: "2", price: 850_000, seller: "Owner", currency: "USD", product: "townhouse" },
          ],
        }),
      })],
      undefined,
      { pageUrl: "https://www.zillow.com/homes/for_sale/San-Francisco-CA/", intent: "get zillow listing" },
    );
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
  });

  it("admits SPA data-fetch URL conventions (/async-*-state) past the body-shape filter", () => {
    // zillow.com/async-create-search-page-state is a real search API. Pre-fix
    // the API-URL bypass only matched /api/ | /graphql | .json — the
    // /async-*-state SPA convention never entered the parsed-body bypass
    // branch, so when body parsing flaked the whole request was dropped at
    // body_not_json_or_html.
    //
    // This probe asserts the trace shows the request reaching the 'candidate'
    // stage (past body-shape). It intentionally does NOT assert that a full
    // endpoint is emitted — downstream semantic gating can still reject
    // based on intent tokens, which is a separate concern.
    const trace: { rows?: Array<Record<string, unknown>> } = {};
    extractEndpoints(
      [req({
        url: "https://www.zillow.com/async-create-search-page-state",
        method: "POST",
        request_body: JSON.stringify({ searchQueryState: { mapBounds: {}, filterState: {} } }),
        response_body: undefined,
        response_headers: {},
      })],
      undefined,
      { pageUrl: "https://www.zillow.com/homes/for_sale/San-Francisco-CA/", intent: "get zillow listing" },
      trace,
    );
    const rows = trace.rows ?? [];
    const bodyRejection = rows.find((r) => r.reason === "body_not_json_or_html");
    expect(bodyRejection).toBeUndefined();
    const reachedCandidate = rows.some((r) => r.kept === true && r.reason === "candidate");
    expect(reachedCandidate).toBe(true);
  });

  it("rejects framework-plumbing graphql ops even through the bypass", () => {
    // LinkedIn voyager uses queryId=voyagerFeedDashGlobalNavs for the top
    // nav chrome — it's graphql but returns no data the agent needs.
    // The graphql bypass must NOT admit this; it should reject via
    // graphql_noise_operation. (sister test:
    // reverse-engineer-admission.test.ts 'drops parsed JSON for
    // global-nav/feed payloads during people search')
    const endpoints = extractEndpoints(
      [req({
        url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashGlobalNavs.123",
        method: "GET",
        request_body: undefined,
        response_body: '{"data":{"viewer":{"urn":"urn:li:fsd_profile:abc"}}}',
      })],
      undefined,
      { pageUrl: "https://www.linkedin.com/search/results/people/?keywords=openai", intent: "search people" },
    );
    expect(endpoints.length).toBe(0);
  });

  it("still admits real graphql data ops (FeedDashMainFeed passes the bypass)", () => {
    // Negative control — the bypass must still work for real data ops
    // even though the noise-op filter applies to the same URL shape.
    // LinkedIn's main feed uses queryId=voyagerFeedDashMainFeed.X which
    // should pass (no globalnav/sidenav substring).
    const endpoints = extractEndpoints(
      [req({
        url: "https://www.linkedin.com/voyager/api/graphql?variables=(count:3,start:0)&queryId=voyagerFeedDashMainFeed.abc",
        method: "GET",
        request_body: undefined,
        response_body: JSON.stringify({
          data: {
            elements: [{
              actor: { name: { text: "Lewis" } },
              socialDetail: { totalSocialActivityCounts: { numLikes: 5, numComments: 2 } },
            }],
            paging: { count: 3, start: 0 },
          },
        }),
      })],
      undefined,
      { pageUrl: "https://www.linkedin.com/feed/", intent: "get feed posts" },
    );
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
  });

  it("still rejects clearly non-sibling domains (brand prefix must overlap)", () => {
    // Sibling bypass must not accept arbitrary domains — e.g. googleapis.com
    // from a page on zillow.com shares no brand prefix.
    const endpoints = extractEndpoints(
      [req({
        url: "https://maps.googleapis.com/maps/api/js?key=abc&libraries=places",
        method: "GET",
        request_body: undefined,
        response_body: "/* javascript */",
      })],
      undefined,
      { pageUrl: "https://www.zillow.com/homes/for_sale/San-Francisco-CA/", intent: "get zillow listing" },
    );
    expect(endpoints.length).toBe(0);
  });
});
