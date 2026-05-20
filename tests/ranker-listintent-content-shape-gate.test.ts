// W4-followup-3 (ranker-wrong-pick / beatsaver): the W4/W4-followup LIST_INTENT
// page-artifact promotion (commits 9681c4c0 + 5976fff9) fires +250 for ANY
// page-artifact whose response_schema is array OR object — including an object
// whose properties are all scalar (e.g. site-metadata `{title:str, url:str}`).
//
// Wave-4 bench-probe (beatsaver): intent "search beatsaver maps" url
// https://beatsaver.com/?q=camellia.
//   - Page-artifact captured a SPA shell that yielded only
//     {title:"BeatSaver.com", url:"https://beatsaver.com"} (zero list cards).
//     dom_extraction.confidence >= 0.5 and response_schema type is "object",
//     so pageArtifactIsDataRich resolves TRUE -> +250 LIST_INTENT promotion.
//   - REST API endpoint /api/search/text/2 returns a real docs[] array.
//     Should be the picked endpoint; instead ranked -112.7 by domain-mismatch /
//     noise filters AND was demoted because the page-artifact won the
//     LIST_INTENT counter-promotion.
//
// The W4 promotion gate needs a content-shape signal beyond "type === object":
// an object schema is list-shaped only if a property is array-typed (items,
// results, docs, posts, products, hits, etc.). Site-metadata objects with
// purely scalar properties are NOT list-shaped and must not get the +250.
//
// Substrate-faithful: this is a STRUCTURAL signal on the schema itself,
// not a per-host registry. The same check generalises to every site that
// captures a SPA shell page-artifact.

import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/ranking/index";
import type { EndpointDescriptor } from "../src/types/index.js";

function ep(over: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://beatsaver.com/",
    description: "",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: { type: "object", properties: { data: { type: "object" } } },
    ...over,
  } as EndpointDescriptor;
}

describe("W4-followup-3: LIST_INTENT page-artifact promotion needs content-shape gate", () => {
  test("beatsaver search: REST /api/search/text/2 ranks above site-meta page-artifact", () => {
    // Page-artifact: dom_extraction confidence is fine, but the extracted
    // schema only carries scalar properties (title, url). That is NOT list-
    // shaped; the +250 LIST_INTENT promotion must NOT fire on this.
    const siteMeta = ep({
      endpoint_id: "beatsaver-page-artifact",
      url_template: "https://beatsaver.com/?q=camellia",
      description: "captured page artifact with structured data",
      response_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
        },
      } as unknown as EndpointDescriptor["response_schema"],
      dom_extraction: {
        extraction_method: "multiple",
        confidence: 0.7,
      } as unknown as EndpointDescriptor["dom_extraction"],
      trigger_url: "https://beatsaver.com/?q=camellia",
    });

    // Real REST search endpoint: array response, true list.
    const restApi = ep({
      endpoint_id: "beatsaver-api-search",
      url_template: "https://beatsaver.com/api/search/text/2?q={q}",
      description: "search beatsaver maps via REST API; returns array of docs",
      response_schema: { type: "array" } as unknown as EndpointDescriptor["response_schema"],
    });

    const ranked = rankEndpoints(
      [siteMeta, restApi],
      "search beatsaver maps",
      "beatsaver.com",
      "https://beatsaver.com/?q=camellia",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("beatsaver-api-search");
  });

  test("docker tags regression guard: object schema with array property IS list-shaped", () => {
    // Sanity guard: this fix must NOT regress the W4 hub.docker.com/_/nginx/tags
    // case. An object schema with an array-typed property (tags / items / docs)
    // IS list-shaped and SHOULD still get the +250 promotion.
    const pageArtifact = ep({
      endpoint_id: "nginx-tags-page",
      url_template: "https://hub.docker.com/_/nginx/tags",
      description: "captured page artifact returning tag list",
      response_schema: {
        type: "object",
        properties: {
          tags: { type: "array" },
        },
      } as unknown as EndpointDescriptor["response_schema"],
      dom_extraction: {
        extraction_method: "page_fetch",
        confidence: 0.85,
      } as unknown as EndpointDescriptor["dom_extraction"],
      trigger_url: "https://hub.docker.com/_/nginx/tags",
    });
    const userEndpoint = ep({
      endpoint_id: "user-details",
      url_template: "https://hub.docker.com/v2/user/",
      description: "Returns user details",
    });
    const ranked = rankEndpoints(
      [userEndpoint, pageArtifact],
      "get dockerhub image tags",
      "hub.docker.com",
      "https://hub.docker.com/_/nginx/tags",
    );
    expect(ranked[0].endpoint.endpoint_id).toBe("nginx-tags-page");
  });
});
