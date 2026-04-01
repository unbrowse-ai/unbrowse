/**
 * Tests that heuristicDescription grounds descriptions in the URL structure and
 * response schema. Covers issue #165.
 */
import { describe, it, expect } from "bun:test";

// endpointSummary is not exported, so we test via heuristicDescription which
// is the public heuristic fallback. We import and call it directly.

import { heuristicDescription } from "../backend/src/services/descriptions.js";

describe("description grounding (issue #165)", () => {
  it("extracts last path segment into description", () => {
    const ep = {
      endpoint_id: "ep1",
      method: "GET" as const,
      url_template: "https://api.example.com/v1/search",
      query: { q: "test", limit: 10, offset: 0 },
      idempotency: "safe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
    };
    const desc = heuristicDescription(ep);
    expect(desc).toContain("search");
  });

  it("handles url_template with path params as last segment", () => {
    const ep = {
      endpoint_id: "ep2",
      method: "GET" as const,
      url_template: "https://api.example.com/users/{userId}/posts/{postId}",
      idempotency: "safe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
    };
    const desc = heuristicDescription(ep);
    // Path params get URL-encoded; the function uses the encoded last segment
    expect(desc).toContain("Returns");
    expect(desc).toContain("data");
  });
  it("extracts meaningful identifier from POST url", () => {
    const ep = {
      endpoint_id: "ep3",
      method: "POST" as const,
      url_template: "https://api.example.com/v1/messages",
      body: { recipient: "user1", text: "hello", priority: "high" },
      idempotency: "unsafe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
    };
    const desc = heuristicDescription(ep);
    expect(desc).toContain("messages");
  });

  it("includes response_schema fields when present", () => {
    const ep = {
      endpoint_id: "ep4",
      method: "GET" as const,
      url_template: "https://api.example.com/v1/bulk",
      response_schema: {
        type: "object" as const,
        properties: { id: { type: "string" }, name: { type: "string" }, status: { type: "string" } },
      },
      idempotency: "safe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
    };
    const desc = heuristicDescription(ep);
    expect(desc).toContain("fields:");
    expect(desc).toContain("id");
    expect(desc).toContain("name");
  });

  it("handles endpoints with no params gracefully", () => {
    const ep = {
      endpoint_id: "ep5",
      method: "GET" as const,
      url_template: "https://api.example.com/v1/health",
      idempotency: "safe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
    };
    const desc = heuristicDescription(ep);
    expect(desc).toContain("Returns");
    expect(desc).toContain("health");
  });

  it("handles DELETE endpoints with path param as last segment", () => {
    const ep = {
      endpoint_id: "ep6",
      method: "DELETE" as const,
      url_template: "https://api.example.com/v1/posts/{postId}",
      idempotency: "unsafe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
    };
    const desc = heuristicDescription(ep);
    // Path params get URL-encoded; the function uses the encoded last segment
    expect(desc).toContain("Returns");
    expect(desc).toContain("data");
  });
});
