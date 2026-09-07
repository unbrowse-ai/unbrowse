// AC2 / lane-01-network-tab-first-replay: for a content-read LIST_INTENT,
// rankEndpoints must pick a real data XHR (items[] array) or a data-rich
// page-artifact over a telemetry-shaped counter XHR. This is the synthetic
// reproduction of the "github search resolved to /search/count instead of
// /search/repositories" class of regression - the count-only endpoint is
// API-shaped but returns no listable content, so it must rank last.
//
// Falsifier: if rankEndpoints can be coaxed to put the count endpoint at
// top-1 for a "search github repos for anthropic" intent, the ranker has
// regressed on the page-artifact-promotion / list-intent-data-shape rule
// documented in CLAUDE.md (Page-artifact promotion for content-read
// intents) and in src/execution/index.ts:rankEndpoints near
// PAGE_ARTIFACT_DEMOTION + LIST_INTENT.

import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/client/rank-server-first";
import type { EndpointDescriptor } from "../src/types/index.js";

function ep(over: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://github.com/",
    description: "",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    action_kind: "read",
    response_schema: { type: "object", properties: {} },
    ...over,
  } as EndpointDescriptor;
}

describe("LIST_INTENT - telemetry-counter XHR loses to real-data XHR and page-artifact", () => {
  test("github search for anthropic: /search/count must not beat /search/repositories or the page artifact", () => {
    const countTelemetry = ep({
      endpoint_id: "search_count",
      method: "GET",
      url_template: "https://github.com/search/count?q={q}",
      description: "Returns total match count for the search query",
      query: { q: "anthropic" },
      response_schema: {
        type: "object",
        properties: {
          count: { type: "number" },
        },
      },
      sample_values: { count: 42 },
    });

    const repositoriesXhr = ep({
      endpoint_id: "search_repositories",
      method: "GET",
      url_template: "https://github.com/search/repositories?q={q}&type={type}",
      description: "Searches GitHub repositories matching a keyword",
      query: { q: "anthropic", type: "Repositories" },
      response_schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                full_name: { type: "string" },
                description: { type: "string" },
                stars: { type: "number" },
              },
            },
          },
        },
      },
      sample_values: {
        items: [
          { full_name: "anthropics/anthropic-sdk-python", description: "Python SDK", stars: 1200 },
          { full_name: "anthropics/claude-code", description: "Claude Code CLI", stars: 8500 },
          { full_name: "anthropics/courses", description: "Anthropic courses", stars: 3300 },
          { full_name: "anthropics/anthropic-cookbook", description: "Cookbook", stars: 2100 },
          { full_name: "anthropics/anthropic-sdk-typescript", description: "TS SDK", stars: 900 },
        ],
      },
    });

    const pageArtifact = ep({
      endpoint_id: "search_page_artifact",
      method: "GET",
      url_template: "https://github.com/search?q={q}&type={type}",
      description: "Captured page artifact for github search results",
      query: { q: "anthropic", type: "Repositories" },
      dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
      response_schema: {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                full_name: { type: "string" },
                description: { type: "string" },
              },
            },
          },
        },
      },
    });

    const ranked = rankEndpoints(
      [countTelemetry, repositoriesXhr, pageArtifact],
      "search github repos for anthropic",
      "github.com",
      "https://github.com/search?q=anthropic&type=Repositories",
    );

    expect(ranked.length).toBe(3);
    const top = ranked[0].endpoint.endpoint_id;
    expect(["search_repositories", "search_page_artifact"]).toContain(top);
    // The telemetry counter must never be top-1 for a listing intent.
    expect(top).not.toBe("search_count");
    // It must also rank strictly below both data-bearing candidates.
    const order = ranked.map((r) => r.endpoint.endpoint_id);
    expect(order.indexOf("search_count")).toBeGreaterThan(order.indexOf("search_repositories"));
  });
});
