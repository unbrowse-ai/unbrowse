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
import { rankEndpoints } from "../src/ranking/index.js";
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

  it("rankEndpoints splits camelCase in descriptions so CollectionItemsCountQuery matches 'collection' intent", () => {
    // opensea.io regression: the GraphQL op CollectionItemsCountQuery
    // was scored -9.4 for intent 'opensea collection' because the
    // description tokenizer lowercased before splitting, turning
    // CollectionItemsCountQuery into ONE token. Fix splits camelCase
    // before lowercasing so 'collection' in the op name lights up the
    // +100 description match bonus.
    const endpoint = {
      endpoint_id: "opensea-collection",
      method: "GET" as const,
      url_template: "https://gql.opensea.io/graphql",
      description: "[GraphQL: CollectionItemsCountQuery] Returns message status with myagent, extensions, and auth",
      semantic: {
        description_source: "agent" as const,
        description_out: "[GraphQL: CollectionItemsCountQuery] Returns message status with myagent, extensions, and auth",
      },
      headers_template: {},
      query: {},
      idempotency: "safe" as const,
      verification_status: "unverified" as const,
      reliability_score: 0.5,
    };
    const genericEndpoint = {
      endpoint_id: "opensea-features",
      method: "GET" as const,
      url_template: "https://features.opensea.io/api/frontend",
      description: "Returns resource details with toggles, names, and enabled",
      semantic: {
        description_source: "agent" as const,
        description_out: "Returns resource details with toggles, names, and enabled",
      },
      headers_template: {},
      query: {},
      idempotency: "safe" as const,
      verification_status: "unverified" as const,
      reliability_score: 0.5,
    };
    const ranked = rankEndpoints(
      [genericEndpoint, endpoint] as any,
      "opensea collection",
      "opensea.io",
      "https://opensea.io/collection/boredapeyachtclub",
    );
    expect(ranked.length).toBeGreaterThanOrEqual(1);
    // The CollectionItemsCountQuery endpoint should outrank the generic
    // features/toggles endpoint for a 'collection' intent.
    const top = ranked[0];
    expect(top).toBeDefined();
    expect(top?.endpoint.endpoint_id).toBe("opensea-collection");
    // And it must score above the relevance threshold (>= 0) so
    // isCachedSkillRelevantForIntent accepts it.
    expect(top?.score).toBeGreaterThanOrEqual(0);
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

describe("X.com GraphQL body detection (isGraphqlRequestBody)", () => {
  it("admits X.com HomeTimeline body (variables + features, no extensions)", () => {
    const xBody = JSON.stringify({
      variables: { count: 20, includePromotedContent: true, latestControlAvailable: true },
      features: { rweb_lists_timeline_redesign_enabled: true, responsive_web_graphql_exclude_directive_enabled: true },
      queryId: "U0cdisy7QFIoTfu3-Okw0A",
    });
    const endpoints = extractEndpoints(
      [{
        url: "https://x.com/i/api/graphql/U0cdisy7QFIoTfu3-Okw0A/HomeTimeline",
        method: "POST",
        request_headers: { "content-type": "application/json", authorization: "Bearer AAAA" },
        request_body: xBody,
        response_status: 200,
        response_headers: { "content-type": "application/json" },
        response_body: JSON.stringify({ data: { home: { home_timeline_urt: { instructions: [] } } } }),
        timestamp: new Date().toISOString(),
      }],
      undefined,
      { pageUrl: "https://x.com/home", intent: "get twitter home timeline" },
    );
    expect(endpoints.length).toBeGreaterThan(0);
    const home = endpoints.find((e) => e.url_template.includes("HomeTimeline"));
    expect(home).toBeDefined();
  });

  it("does not regress: still admits variables + extensions shape", () => {
    const body = JSON.stringify({ operationName: "SearchTweets", variables: { q: "unbrowse" }, extensions: { persistedQuery: { version: 1, sha256Hash: "abc" } } });
    const endpoints = extractEndpoints(
      [{
        url: "https://x.com/i/api/graphql/abc123/SearchTweets",
        method: "POST",
        request_headers: { "content-type": "application/json" },
        request_body: body,
        response_status: 200,
        response_headers: { "content-type": "application/json" },
        response_body: JSON.stringify({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [] } } } } }),
        timestamp: new Date().toISOString(),
      }],
      undefined,
      { pageUrl: "https://x.com/search?q=unbrowse", intent: "search twitter for unbrowse" },
    );
    expect(endpoints.length).toBeGreaterThan(0);
  });
});
