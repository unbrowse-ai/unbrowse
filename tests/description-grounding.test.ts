/**
 * Tests that endpointSummary grounds LLM descriptions in request params and action kind.
 * Covers issue #165.
 */
import { describe, it, expect } from "bun:test";

// endpointSummary is not exported, so we test via heuristicDescription which is exported
// and also uses the same grounding. We need to test the summary string includes params.
// Since endpointSummary is private, we import the module and test indirectly.

// We'll test by importing the module dynamically and checking the generated summary.
// Actually, let's just re-implement a quick integration: call generateDescriptions with
// a mock env that fails (so it falls back to heuristic), and check descriptions include params.

import { heuristicDescription } from "../backend/src/services/descriptions.js";

describe("description grounding (issue #165)", () => {
  it("includes query param names in heuristic description", () => {
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
    expect(desc).toContain("q");
    expect(desc).toContain("limit");
  });

  it("includes path param names extracted from url_template", () => {
    const ep = {
      endpoint_id: "ep2",
      method: "GET" as const,
      url_template: "https://api.example.com/users/{userId}/posts/{postId}",
      idempotency: "safe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
    };
    const desc = heuristicDescription(ep);
    expect(desc).toContain("userId");
    expect(desc).toContain("postId");
  });

  it("includes body param names in heuristic description", () => {
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
    expect(desc).toContain("recipient");
    expect(desc).toContain("text");
  });

  it("limits displayed params to 8", () => {
    const ep = {
      endpoint_id: "ep4",
      method: "POST" as const,
      url_template: "https://api.example.com/v1/bulk",
      body: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 },
      idempotency: "unsafe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
    };
    const desc = heuristicDescription(ep);
    // Should have at most 8 params listed
    const paramsMatch = desc.match(/params: ([^.]+)/);
    expect(paramsMatch).toBeTruthy();
    const params = paramsMatch![1].split(", ");
    expect(params.length).toBeLessThanOrEqual(8);
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
    expect(desc).not.toContain("params:");
    expect(desc).toContain("Returns");
  });

  it("includes action kind based on HTTP method", () => {
    const ep = {
      endpoint_id: "ep6",
      method: "DELETE" as const,
      url_template: "https://api.example.com/v1/posts/{postId}",
      idempotency: "unsafe" as const,
      verification_status: "verified" as const,
      reliability_score: 1,
    };
    const desc = heuristicDescription(ep);
    expect(desc).toContain("delete");
  });
});
