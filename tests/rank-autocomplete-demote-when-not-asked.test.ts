import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/client/rank-server-first";
import type { EndpointDescriptor } from "../src/types/index.js";

// W-RANKER-DEMOTE-AUTOCOMPLETE: when the user's intent is a real LIST
// intent (search, list, find, ...) and one candidate endpoint's URL path
// is an autocomplete/suggestions/typeahead endpoint while another is the
// canonical page or list endpoint, the autocomplete endpoint must NOT
// outrank the real list endpoint.
//
// Live regression source: .bench-gate/20260520T015714Z probe 030 pubmed.
// The shortlist had:
//   - https://pubmed.ncbi.nlm.nih.gov/suggestions/?term={term} (score -97)
//   - https://pubmed.ncbi.nlm.nih.gov/?term={term}             (score -2127)
// The autocomplete URL won; execute returned 20 query-completion strings
// instead of paper results.
//
// Fix: a generic URL-token signal in rankEndpoints (no per-domain logic).
// When intent matches LIST_INTENT and DOES NOT mention any
// autocomplete-shaped term (suggest, suggestion, suggestions, autocomplete,
// typeahead, complete, hint, lookup), demote endpoints whose path contains
// one of those tokens.
//
// Real-runtime: live rankEndpoints, no mocks.

function ep(overrides: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://example.com/",
    description: "",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    ...overrides,
  } as EndpointDescriptor;
}

describe("rankEndpoints - W-RANKER-DEMOTE-AUTOCOMPLETE", () => {
  test("pubmed search ranks /?term over /suggestions/?term", () => {
    const realPage = ep({
      endpoint_id: "real-page",
      url_template: "https://pubmed.ncbi.nlm.nih.gov/?term={term}",
      description: "Page content from pubmed.ncbi.nlm.nih.gov",
      response_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
      },
    });
    const autocomplete = ep({
      endpoint_id: "autocomplete",
      url_template: "https://pubmed.ncbi.nlm.nih.gov/suggestions/?term={term}",
      description: "Searches Suggestions with code, suggestions, term using term",
      response_schema: {
        type: "object",
        properties: {
          code: { type: "number" },
          suggestions: { type: "array" },
          term: { type: "string" },
        },
      },
    });

    const ranked = rankEndpoints(
      [autocomplete, realPage],
      "search pubmed papers",
      "pubmed.ncbi.nlm.nih.gov",
      "https://pubmed.ncbi.nlm.nih.gov/?term=machine+learning",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("real-page");
    const autocompleteRanked = ranked.find((r) => r.endpoint.endpoint_id === "autocomplete");
    if (autocompleteRanked) {
      expect(autocompleteRanked.score).toBeLessThan(ranked[0].score);
    }
  });

  test("typeahead path is demoted vs canonical list path on LIST intent", () => {
    const realList = ep({
      endpoint_id: "real-list",
      url_template: "https://example.com/products?q={q}",
      description: "Products search results",
      response_schema: { type: "array" },
    });
    const typeahead = ep({
      endpoint_id: "typeahead",
      url_template: "https://example.com/typeahead?q={q}",
      description: "Typeahead suggestions",
      response_schema: { type: "array" },
    });

    const ranked = rankEndpoints(
      [typeahead, realList],
      "find products",
      "example.com",
      "https://example.com/products?q=cable",
    );

    expect(ranked[0].endpoint.endpoint_id).toBe("real-list");
  });

  test("when intent explicitly asks for suggestions, the suggest endpoint is NOT demoted", () => {
    const realPage = ep({
      endpoint_id: "real-page",
      url_template: "https://api.example.com/search?q={q}",
      description: "Full search",
      response_schema: { type: "array" },
    });
    const suggest = ep({
      endpoint_id: "suggest",
      url_template: "https://api.example.com/suggest?q={q}",
      description: "Query suggestions",
      response_schema: { type: "array" },
    });

    const ranked = rankEndpoints(
      [realPage, suggest],
      "get query suggestions",
      "api.example.com",
      "https://api.example.com/suggest?q=ma",
    );

    // The suggest endpoint should be at or near the top; not demoted out
    // of contention. We assert it's not penalised relative to the search
    // endpoint when the user explicitly asked for suggestions.
    const suggestRanked = ranked.find((r) => r.endpoint.endpoint_id === "suggest");
    const searchRanked = ranked.find((r) => r.endpoint.endpoint_id === "real-page");
    expect(suggestRanked).toBeDefined();
    expect(searchRanked).toBeDefined();
    if (suggestRanked && searchRanked) {
      expect(suggestRanked.score).toBeGreaterThanOrEqual(searchRanked.score - 50);
    }
  });
});
