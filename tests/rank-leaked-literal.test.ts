import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/execution/index";
import type { EndpointDescriptor } from "../src/types/index.js";

// A1 fix — leaked-literal path-segment penalty.
//
// Before: querying r/singularity could surface a captured r/programming
// endpoint with rich data (executed earlier) and rank it competitively, even
// though `programming` doesn't appear in the user's intent or contextUrl.
// After: the leaked-literal penalty (-200 per non-shared, non-templated
// literal segment that isn't in intent or contextUrl) buries the wrong
// endpoint below the right one.

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

describe("rankEndpoints A1 — leaked-literal path-segment penalty", () => {
  test("r/singularity intent ranks correct subreddit above leaked r/programming", () => {
    const right = ep({
      endpoint_id: "right",
      url_template: "https://reddit.com/r/singularity/hot/.json",
      description: "Structured replay for r/singularity hot posts",
    });
    const wrong = ep({
      endpoint_id: "wrong",
      url_template: "https://www.reddit.com/r/programming/.json",
      description: "Structured replay for get subreddit posts",
      response_schema: {
        type: "object",
        properties: { kind: { type: "string" }, data: { type: "object" } },
      },
    });
    const ranked = rankEndpoints(
      [wrong, right],
      "get r/singularity hot posts",
      "reddit.com",
      "https://reddit.com/r/singularity/hot",
    );
    // The right one must rank first.
    expect(ranked[0].endpoint.endpoint_id).toBe("right");
    // The wrong one must be heavily penalised (or filtered if score < 0).
    const wrongRanked = ranked.find((r) => r.endpoint.endpoint_id === "wrong");
    if (wrongRanked) {
      expect(wrongRanked.score).toBeLessThan(ranked[0].score - 100);
    }
  });

  test("does not penalise endpoints whose path segments are in the intent", () => {
    const legit = ep({
      endpoint_id: "legit",
      url_template: "https://api.example.com/v1/orders/{order_id}",
      description: "Get order details",
    });
    const ranked = rankEndpoints(
      [legit],
      "get order details for order 12345",
      "api.example.com",
      "https://example.com/orders/12345",
    );
    // `orders` appears in the intent, `v1` is in shared-token whitelist.
    // No leaked literals → no penalty.
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  test("does not penalise generic shared-token segments (api, v1, graphql, json)", () => {
    const apiSeg = ep({
      endpoint_id: "api",
      url_template: "https://api.example.com/v2/graphql/users.json",
      description: "user data",
    });
    const ranked = rankEndpoints(
      [apiSeg],
      "fetch user data",
      "example.com",
      "https://example.com/profile",
    );
    // None of {api, v2, graphql, users, json} should trigger the penalty.
    expect(ranked[0].score).toBeGreaterThan(-100);
  });

  test("opaque ids and numeric segments are not treated as leaked literals", () => {
    const opaque = ep({
      endpoint_id: "opaque",
      url_template: "https://api.example.com/v1/users/abcdef0123456789/posts",
      description: "user posts",
    });
    const ranked = rankEndpoints(
      [opaque],
      "fetch user posts",
      "example.com",
      "https://example.com/u/somebody",
    );
    // 16-char hex id is filtered; `users` and `posts` are shared tokens.
    expect(ranked[0].score).toBeGreaterThan(-100);
  });
});
