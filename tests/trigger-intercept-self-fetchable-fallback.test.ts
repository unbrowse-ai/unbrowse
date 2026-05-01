import { describe, expect, test } from "bun:test";

// Mirror the self-fetchable detector + fallback gate from
// src/execution/index.ts (both the no-strategy first-time and learned
// strategy branches). Status:0 from triggerAndIntercept means the target
// API call was never intercepted within 15s — usually because the page
// itself IS the JSON endpoint (reddit r/{sub}/comments/{id}/{slug}/.json).
// In that case serverFetch is the natural strategy.

const isSelfFetchable = (method: string, url: string): boolean =>
  method === "GET" && /\.(json)(\?|$)|\/api\//i.test(url);

const shouldFallbackToServerFetch = (status: number, method: string, url: string): boolean =>
  status === 0 && isSelfFetchable(method, url);

describe("trigger-intercept fallback to serverFetch on self-fetchable URLs", () => {
  test("reddit comments .json — fallback fires", () => {
    expect(shouldFallbackToServerFetch(
      0,
      "GET",
      "https://www.reddit.com/r/programming/comments/1q6abc/example_post/.json",
    )).toBe(true);
  });

  test("reddit comments .json with query — fallback fires", () => {
    expect(shouldFallbackToServerFetch(
      0,
      "GET",
      "https://www.reddit.com/r/programming/comments/1q6abc/example_post/.json?limit=10",
    )).toBe(true);
  });

  test("API path — fallback fires", () => {
    expect(shouldFallbackToServerFetch(0, "GET", "https://example.com/api/v1/users")).toBe(true);
  });

  test("status 200 — no fallback (success)", () => {
    expect(shouldFallbackToServerFetch(200, "GET", "https://example.com/api/v1/users")).toBe(false);
  });

  test("HTML page — no fallback (might genuinely need browser)", () => {
    expect(shouldFallbackToServerFetch(0, "GET", "https://example.com/feed")).toBe(false);
  });

  test("POST — no fallback (might mutate)", () => {
    expect(shouldFallbackToServerFetch(0, "POST", "https://example.com/api/v1/comment")).toBe(false);
  });
});
