import { describe, expect, it } from "bun:test";
import { rankEndpoints } from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

describe("rankEndpoints search selection", () => {
  it("prefers a real search endpoint over a captured page artifact sibling", () => {
    const artifact: EndpointDescriptor = {
      endpoint_id: "artifact",
      method: "GET",
      url_template: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.8,
      description: "Captured page artifact for searching cases",
      trigger_url: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      dom_extraction: {
        extraction_method: "repeated-elements",
        confidence: 0.8,
        selector: "div#results",
      },
      semantic: {
        action_kind: "search",
        resource_kind: "resource",
        description_in: "No additional inputs required",
        description_out: "Captured page artifact for searching cases",
        response_summary: "[].title",
        example_request: {},
        example_response_compact: [{ title: "Search Results" }],
        example_fields: ["[].title"],
        requires: [],
        provides: [],
        negative_tags: [],
        confidence: 0.8,
        observed_at: new Date().toISOString(),
        auth_required: true,
      },
    };

    const search: EndpointDescriptor = {
      endpoint_id: "search",
      method: "POST",
      url_template: "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
      idempotency: "safe",
      verification_status: "unverified",
      reliability_score: 0.5,
      description: "Searches documents with title, link, url, description",
      trigger_url: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      body_params: {
        basic_search_key: "late evidence",
      },
      body: {
        basicSearchKey: "{basic_search_key}",
        grouping: "1",
      },
      semantic: {
        action_kind: "search",
        resource_kind: "document",
        description_in: "Requires basic_search_key",
        description_out: "Searches documents with title, link, url, description",
        response_summary: "[].title, [].link, [].url, [].description",
        example_request: { basicSearchKey: "{basic_search_key}" },
        example_response_compact: [{ title: "Foo v Bar [2024] SGHC 1" }],
        example_fields: ["[].title", "[].link"],
        requires: [],
        provides: [],
        negative_tags: [],
        confidence: 0.8,
        observed_at: new Date().toISOString(),
        auth_required: true,
      },
    };

    const ranked = rankEndpoints(
      [artifact, search],
      "search for high court case assessment of damages new evidence adduced after tranches started",
      "www.lawnet.sg",
      "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
    );

    expect(ranked[0]?.endpoint.endpoint_id).toBe("search");
  });

  it("prefers a structured search-results endpoint over artifacts and raw html form posts", () => {
    const loginArtifact: EndpointDescriptor = {
      endpoint_id: "login-artifact",
      method: "GET",
      url_template: "https://www.lawnet.sg/lawnet/web/lawnet/home?p_p_state={p_p_state}",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.8,
      description: "Captured page artifact for search for cases",
      trigger_url:
        "https://www.lawnet.sg/lawnet/web/lawnet/home?p_p_state=minimize&_58_redirect=%2Flawnet%2Fgroup%2Flawnet%2Flegal-research%2Fbasic-search",
      dom_extraction: {
        extraction_method: "repeated-elements",
        confidence: 0.8,
        selector: "div#content",
      },
      semantic: {
        action_kind: "search",
        resource_kind: "resource",
        description_in: "No additional inputs required",
        description_out: "Captured page artifact for search for cases",
        response_summary: "[].title",
        example_request: {},
        example_response_compact: [{ title: "LawNet" }],
        example_fields: ["[].title"],
        requires: [],
        provides: [],
        negative_tags: [],
        confidence: 0.8,
        observed_at: new Date().toISOString(),
        auth_required: true,
      },
    };

    const landingArtifact: EndpointDescriptor = {
      endpoint_id: "landing-artifact",
      method: "GET",
      url_template: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 0.8,
      description: "Captured page artifact for search for cases",
      trigger_url: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      dom_extraction: {
        extraction_method: "repeated-elements",
        confidence: 0.8,
        selector: "div#content",
      },
      semantic: {
        action_kind: "search",
        resource_kind: "resource",
        description_in: "No additional inputs required",
        description_out: "Captured page artifact for search for cases",
        response_summary: "[].title",
        example_request: {},
        example_response_compact: [{ title: "About LawNet Legal Research" }],
        example_fields: ["[].title"],
        requires: [],
        provides: [],
        negative_tags: [],
        confidence: 0.8,
        observed_at: new Date().toISOString(),
        auth_required: true,
      },
    };

    const rawHtmlSearch: EndpointDescriptor = {
      endpoint_id: "raw-search",
      method: "POST",
      url_template: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      idempotency: "safe",
      verification_status: "unverified",
      reliability_score: 0.5,
      description: "Searches documents",
      trigger_url: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      body_params: {
        searchbasicformportlet_query: "late evidence",
      },
      body: {
        _searchbasicformportlet_query: "{searchbasicformportlet_query}",
      },
      semantic: {
        action_kind: "search",
        resource_kind: "document",
        description_in: "Requires searchbasicformportlet_query",
        description_out: "Searches documents",
        response_summary: "<html>...</html>",
        example_request: {
          _searchbasicformportlet_query: "{searchbasicformportlet_query}",
        },
        example_response_compact: {
          html: "<!doctype html><html><title>LawNet</title></html>",
        },
        example_fields: ["html"],
        requires: [],
        provides: [],
        negative_tags: [],
        confidence: 0.8,
        observed_at: new Date().toISOString(),
        auth_required: true,
      },
    };

    const structuredSearch: EndpointDescriptor = {
      endpoint_id: "structured-search",
      method: "POST",
      url_template: "https://www.lawnet.sg/lawnet/group/lawnet/result-page",
      idempotency: "safe",
      verification_status: "unverified",
      reliability_score: 0.5,
      description: "Searches documents with title, link, url, description",
      trigger_url: "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
      body_params: {
        basic_search_key: "late evidence",
      },
      body: {
        basicSearchKey: "{basic_search_key}",
        grouping: "1",
      },
      dom_extraction: {
        extraction_method: "repeated-elements",
        confidence: 0.8,
        selector: "article",
      },
      response_schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            link: { type: "string" },
          },
        },
      } as any,
      semantic: {
        action_kind: "search",
        resource_kind: "document",
        description_in: "Requires basic_search_key",
        description_out: "Searches documents with title, link, url, description",
        response_summary: "[].title, [].link, [].url, [].description",
        example_request: { basicSearchKey: "{basic_search_key}" },
        example_response_compact: [{ title: "Foo v Bar [2024] SGHC 1" }],
        example_fields: ["[].title", "[].link"],
        requires: [],
        provides: [],
        negative_tags: [],
        confidence: 0.8,
        observed_at: new Date().toISOString(),
        auth_required: true,
      },
    };

    const ranked = rankEndpoints(
      [loginArtifact, landingArtifact, rawHtmlSearch, structuredSearch],
      "search for high court case assessment of damages new evidence adduced after tranches started",
      "www.lawnet.sg",
      "https://www.lawnet.sg/lawnet/group/lawnet/legal-research/basic-search",
    );

    expect(ranked[0]?.endpoint.endpoint_id).toBe("structured-search");
    expect(ranked.findIndex((item) => item.endpoint.endpoint_id === "landing-artifact")).toBeGreaterThan(
      ranked.findIndex((item) => item.endpoint.endpoint_id === "structured-search"),
    );
    expect(ranked.findIndex((item) => item.endpoint.endpoint_id === "raw-search")).toBeGreaterThan(
      ranked.findIndex((item) => item.endpoint.endpoint_id === "structured-search"),
    );
  });
});
