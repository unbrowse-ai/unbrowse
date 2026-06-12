import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/client/rank-server-first";
import { EMPTY_ENTITY_BAG_FLOOR } from "../src/lib/ranking-core/clamps";
import type { EndpointDescriptor } from "../src/types/index.js";

function ep(over: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://x.com/",
    description: "",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: { type: "object", properties: {} },
    ...over,
  } as EndpointDescriptor;
}

function emptyStore() {
  return {
    type: "object",
    properties: {
      entities: { type: "object", properties: {}, required: [] },
      errors: { type: "object", properties: {}, required: [] },
      fetchStatus: { type: "object", properties: {}, required: [] },
    },
    required: ["entities", "errors", "fetchStatus"],
  };
}

describe("W3 empty entity-bag page artifacts", () => {
  test("x.com SPA state with empty normalized bags loses to a real timeline API", () => {
    const emptySpaState = ep({
      endpoint_id: "x-empty-spa-state",
      url_template: "https://x.com/search?q={q}&src={src}",
      description: "Page content from x.com",
      trigger_url: "https://x.com/search?q=AI+agents&src=typed_query",
      dom_extraction: { extraction_method: "spa-initial-state", confidence: 1 },
      response_schema: {
        type: "object",
        properties: {
          optimist: { type: "array" },
          entities: {
            type: "object",
            properties: {
              broadcasts: emptyStore(),
              cards: emptyStore(),
              conversations: emptyStore(),
              entries: emptyStore(),
              lists: emptyStore(),
              topics: emptyStore(),
              tweets: emptyStore(),
              users: emptyStore(),
            },
          },
          featureSwitch: { type: "object", properties: { defaultConfig: { type: "object" } } },
        },
      } as unknown as EndpointDescriptor["response_schema"],
    });

    const timelineApi = ep({
      endpoint_id: "x-home-timeline-api",
      url_template: "https://x.com/i/api/graphql/HomeTimeline?variables={variables}&features={features}",
      description: "[GraphQL: HomeTimeline] Returns posts timeline",
      response_schema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              home: {
                type: "object",
                properties: {
                  home_timeline_urt: {
                    type: "object",
                    properties: {
                      instructions: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            entries: {
                              type: "array",
                              items: { type: "object" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      } as unknown as EndpointDescriptor["response_schema"],
    });

    const htmlFallback = ep({
      endpoint_id: "x-rendered-html",
      url_template: "https://x.com/search?q={q}&src={src}",
      description: "Returns rendered page for search tweets about AI agents",
      trigger_url: "https://x.com/search?q=AI+agents&src=typed_query",
      dom_extraction: { extraction_method: "page_fetch", confidence: 0.5 },
      response_schema: { type: "string", format: "html" } as unknown as EndpointDescriptor["response_schema"],
    });

    const ranked = rankEndpoints(
      [emptySpaState, htmlFallback, timelineApi],
      "search tweets about AI agents",
      "x.com",
      "https://x.com/search?q=AI+agents&src=typed_query",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("x-home-timeline-api");
    const emptyStateRank = ranked.find((r) => r.endpoint.endpoint_id === "x-empty-spa-state");
    expect(emptyStateRank?.score).toBeLessThanOrEqual(EMPTY_ENTITY_BAG_FLOOR);
    const htmlFallbackRank = ranked.find((r) => r.endpoint.endpoint_id === "x-rendered-html");
    expect(htmlFallbackRank?.score).toBeLessThanOrEqual(EMPTY_ENTITY_BAG_FLOOR);
  });
});
