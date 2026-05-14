// Positive-control regression: for a generic LIST_INTENT like "find shoes
// on carousell" or "search products on example", the ranker must NOT promote
// a personalization/widget endpoint above the canonical search surface. These
// probes pin the current ranker behavior so a future change doesn't regress
// it. The actual root-cause fix for the 2026-05-14 carousell session lives
// at the text-extraction layer (see tests/browse-markdown-structured-header.test.ts
// and src/extraction/index.ts:buildStructuredDataHeader) — the ranker side
// only matters when the agent re-resolves and executes the captured skill.

import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/ranking/index";
import type { EndpointDescriptor } from "../src/types/index.js";

function ep(over: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://www.carousell.sg/",
    description: "",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: { type: "object", properties: { data: { type: "object" } } },
    ...over,
  } as EndpointDescriptor;
}

describe("LIST_INTENT — rec-widget endpoints lose to canonical search surface", () => {
  test("carousell shoes: dropped_in_price rec widget ranks below /search/shoes", () => {
    const recWidget = ep({
      endpoint_id: "rec_widget",
      method: "GET",
      url_template: "https://www.carousell.sg/ds/field-data-proto/cf/rec/1.0/dropped_in_price/?_path={path}&country_id={country_id}&l={l}&responseType={responseType}",
      description: "Returns form status with session, counts, and ids",
      response_schema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              session: { type: "string" },
              results: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
    });
    const searchPage = ep({
      endpoint_id: "search_page",
      method: "GET",
      url_template: "https://www.carousell.sg/search/shoes",
      description: "Search results page for shoes",
      response_schema: {
        type: "object",
        properties: {
          "@context": { type: "string" },
          "@type": { type: "string" },
          itemListElement: { type: "array", items: { type: "object" } },
        },
      },
    });

    const ranked = rankEndpoints(
      [recWidget, searchPage],
      "find me shoes on carousell",
      "carousell.sg",
      "https://www.carousell.sg/search/shoes/",
    );

    expect(ranked.length).toBe(2);
    expect(ranked[0].endpoint.endpoint_id).toBe("search_page");
  });

  test("generic search intent: a 'recommended' XHR ranks below /search?q=", () => {
    const recXhr = ep({
      endpoint_id: "recs",
      url_template: "https://example.com/api/v1/recommendations/for_you?session={session}",
      description: "Personalized recommendations feed",
      response_schema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "object" } },
        },
      },
    });
    const search = ep({
      endpoint_id: "search",
      url_template: "https://example.com/api/v1/search?q={q}",
      description: "Search products by keyword",
      response_schema: {
        type: "object",
        properties: {
          results: { type: "array", items: { type: "object" } },
        },
      },
    });

    const ranked = rankEndpoints(
      [recXhr, search],
      "search products on example",
      "example.com",
      "https://example.com/search?q=widgets",
    );

    expect(ranked.length).toBe(2);
    expect(ranked[0].endpoint.endpoint_id).toBe("search");
  });
});
