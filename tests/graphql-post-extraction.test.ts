import { describe, expect, it } from "bun:test";
import { extractEndpoints, extractGraphQLOperationName } from "../src/reverse-engineer/index.js";
import { mergePassiveCaptureData } from "../src/capture/index.js";
import type { RawRequest } from "../src/capture/index.js";

function makeRequest(overrides: Partial<RawRequest>): RawRequest {
  return {
    url: "https://example.com/api/data",
    method: "GET",
    request_headers: {},
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: '{"data":{"items":[{"id":"1","name":"Test"}]}}',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("extractGraphQLOperationName", () => {
  it("extracts operationName from standard GraphQL body", () => {
    const result = extractGraphQLOperationName(
      "https://example.com/graphql",
      JSON.stringify({ operationName: "UserTweets", variables: { userId: "123" } }),
    );
    expect(result).toBe("UserTweets");
  });

  it("extracts operationName from inline query", () => {
    const result = extractGraphQLOperationName(
      "https://example.com/graphql",
      JSON.stringify({ query: "query HomeTimeline($count: Int) { timeline { items } }" }),
    );
    expect(result).toBe("HomeTimeline");
  });

  it("extracts fb_api_req_friendly_name from Facebook body", () => {
    const result = extractGraphQLOperationName(
      "https://www.facebook.com/api/graphql/",
      JSON.stringify({ fb_api_req_friendly_name: "ProfileCometTimelineFeedRefetchQuery", doc_id: "7654321", variables: "{}" }),
    );
    expect(result).toBe("ProfileCometTimelineFeedRefetchQuery");
  });

  it("extracts doc_id from Facebook body when no friendly name", () => {
    const result = extractGraphQLOperationName(
      "https://www.facebook.com/api/graphql/",
      JSON.stringify({ doc_id: "1234567890", variables: "{}" }),
    );
    expect(result).toBe("doc_1234567890");
  });

  it("extracts numeric doc_id from Facebook body", () => {
    const result = extractGraphQLOperationName(
      "https://www.facebook.com/api/graphql/",
      JSON.stringify({ doc_id: 9876543210, variables: "{}" }),
    );
    expect(result).toBe("doc_9876543210");
  });

  it("extracts query_hash from Instagram body", () => {
    const result = extractGraphQLOperationName(
      "https://www.instagram.com/graphql/query",
      JSON.stringify({ query_hash: "abc123def456", variables: "{}" }),
    );
    expect(result).toBe("qh_abc123def456");
  });

  it("extracts operation name from X.com URL path", () => {
    const result = extractGraphQLOperationName(
      "https://x.com/i/api/graphql/aB1cD2eF/UserTweets",
      JSON.stringify({ variables: { userId: "123" } }),
    );
    expect(result).toBe("UserTweets");
  });

  it("extracts from URL-encoded form data (Facebook fallback)", () => {
    const result = extractGraphQLOperationName(
      "https://www.facebook.com/api/graphql/",
      "fb_api_req_friendly_name=CometFeedQuery&doc_id=12345&variables=%7B%7D",
    );
    expect(result).toBe("CometFeedQuery");
  });

  it("returns undefined for non-GraphQL body", () => {
    const result = extractGraphQLOperationName(
      "https://example.com/graphql",
      JSON.stringify({ data: "not a graphql request" }),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when no body provided", () => {
    const result = extractGraphQLOperationName("https://example.com/graphql");
    expect(result).toBeUndefined();
  });
});

describe("GraphQL POST endpoint extraction", () => {
  it("keeps GraphQL POST requests with JSON response bodies", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://x.com/i/api/graphql/abc123/UserTweets",
        method: "POST",
        request_body: JSON.stringify({ variables: { userId: "123", count: 20 }, features: {} }),
        response_body: JSON.stringify({ data: { user: { result: { timeline_v2: { timeline: { instructions: [] } } } } } }),
      }),
    ], undefined, { pageUrl: "https://x.com/user123" });
    expect(endpoints.length).toBe(1);
    expect(endpoints[0].method).toBe("POST");
    expect(endpoints[0].graphql_info?.operation_name).toBe("UserTweets");
  });

  it("deduplicates different GraphQL operations to the same URL", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        request_body: JSON.stringify({ fb_api_req_friendly_name: "ProfileQuery", doc_id: "111", variables: "{}" }),
        response_body: JSON.stringify({ data: { user: { name: "Test" } } }),
      }),
      makeRequest({
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        request_body: JSON.stringify({ fb_api_req_friendly_name: "FeedQuery", doc_id: "222", variables: "{}" }),
        response_body: JSON.stringify({ data: { feed: { edges: [] } } }),
      }),
      makeRequest({
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        request_body: JSON.stringify({ fb_api_req_friendly_name: "ProfileQuery", doc_id: "111", variables: "{}" }),
        response_body: JSON.stringify({ data: { user: { name: "Test2" } } }),
      }),
    ], undefined, { pageUrl: "https://www.facebook.com/profile" });
    // Should get 2 unique endpoints (ProfileQuery and FeedQuery), not 1 or 3
    expect(endpoints.length).toBe(2);
    const opNames = endpoints.map(e => e.graphql_info?.operation_name).sort();
    expect(opNames).toContain("FeedQuery");
    expect(opNames).toContain("ProfileQuery");
  });

  it("admits GraphQL POST with missing response body via synthetic fallback", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://x.com/i/api/graphql/xyz789/HomeTimeline",
        method: "POST",
        request_body: JSON.stringify({ variables: { count: 20 }, features: {} }),
        response_body: undefined, // Response body not captured (e.g., too large)
        response_headers: {},
      }),
    ], undefined, { pageUrl: "https://x.com/home" });
    expect(endpoints.length).toBe(1);
    expect(endpoints[0].graphql_info?.operation_name).toBe("HomeTimeline");
  });

  it("includes GraphQL operation name in endpoint description", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://x.com/i/api/graphql/abc123/UserTweets",
        method: "POST",
        request_body: JSON.stringify({ operationName: "UserTweets", variables: { userId: "123" } }),
        response_body: JSON.stringify({ data: { user: { tweets: [] } } }),
      }),
    ], undefined, { pageUrl: "https://x.com/user123" });
    expect(endpoints.length).toBe(1);
    expect(endpoints[0].description).toContain("UserTweets");
  });

  it("does not break existing GET endpoint extraction", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://api.example.com/v1/users?page=1",
        method: "GET",
        response_body: JSON.stringify({ users: [{ id: 1, name: "Alice" }] }),
      }),
    ], undefined, { pageUrl: "https://example.com/users" });
    expect(endpoints.length).toBe(1);
    expect(endpoints[0].method).toBe("GET");
    expect(endpoints[0].graphql_info).toBeUndefined();
  });
});

describe("mergePassiveCaptureData GraphQL dedup", () => {
  it("keeps different Facebook GraphQL operations as separate entries", () => {
    const intercepted = [
      {
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        response_body: JSON.stringify({ data: { user: {} } }),
        response_status: 200,
        request_headers: {},
        response_headers: {},
        request_body: JSON.stringify({ fb_api_req_friendly_name: "ProfileQuery", doc_id: "111" }),
        timestamp: new Date().toISOString(),
      },
      {
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        response_body: JSON.stringify({ data: { feed: {} } }),
        response_status: 200,
        request_headers: {},
        response_headers: {},
        request_body: JSON.stringify({ fb_api_req_friendly_name: "FeedQuery", doc_id: "222" }),
        timestamp: new Date().toISOString(),
      },
    ];
    const merged = mergePassiveCaptureData(intercepted, [], [], new Map());
    expect(merged.length).toBe(2);
  });

  it("deduplicates same Facebook GraphQL operation", () => {
    const intercepted = [
      {
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        response_body: JSON.stringify({ data: { user: {} } }),
        response_status: 200,
        request_headers: {},
        response_headers: {},
        request_body: JSON.stringify({ fb_api_req_friendly_name: "ProfileQuery", doc_id: "111" }),
        timestamp: new Date().toISOString(),
      },
      {
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        response_body: JSON.stringify({ data: { user: { updated: true } } }),
        response_status: 200,
        request_headers: {},
        response_headers: {},
        request_body: JSON.stringify({ fb_api_req_friendly_name: "ProfileQuery", doc_id: "111" }),
        timestamp: new Date().toISOString(),
      },
    ];
    const merged = mergePassiveCaptureData(intercepted, [], [], new Map());
    // Same operation should be deduped to 1
    expect(merged.length).toBe(1);
  });

  it("HAR entries without postData collapse all Facebook GraphQL ops to 1 — demonstrating the bug", () => {
    // This simulates what happens when:
    // 1. The JS interceptor drops entries (response body >2MB)
    // 2. HAR captures the requests but without POST bodies (HAR postData is often missing for SPAs)
    // Result: all 3 operations collapse to 1 because graphqlDedup can't distinguish them
    const harEntries = [
      {
        startedDateTime: new Date().toISOString(),
        request: { method: "POST", url: "https://www.facebook.com/api/graphql/", headers: [], postData: undefined },
        response: { status: 200, headers: [{ name: "content-type", value: "application/json" }], content: { text: "" } },
      },
      {
        startedDateTime: new Date().toISOString(),
        request: { method: "POST", url: "https://www.facebook.com/api/graphql/", headers: [], postData: undefined },
        response: { status: 200, headers: [{ name: "content-type", value: "application/json" }], content: { text: "" } },
      },
      {
        startedDateTime: new Date().toISOString(),
        request: { method: "POST", url: "https://www.facebook.com/api/graphql/", headers: [], postData: undefined },
        response: { status: 200, headers: [{ name: "content-type", value: "application/json" }], content: { text: "" } },
      },
    ] as any[];

    const merged = mergePassiveCaptureData([], harEntries, [], new Map());
    // BUG: without postData, all 3 collapse to 1 entry — this demonstrates the root cause
    // The fix is in the interceptor: record entries even when response body is too large
    // so that request_body (with operationName) is always preserved
    expect(merged.length).toBe(1); // This is the bug: should be 3 if we had request bodies
  });

  it("interceptor entries with empty response_body (large-response fallback) still preserve operation identity", () => {
    // After the fix: interceptor records entries with empty response_body when response is too large
    // The request_body with operationName is still present for deduplication
    const intercepted = [
      {
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        response_body: "", // Empty — response was too large, interceptor truncated it
        response_status: 200,
        request_headers: {},
        response_headers: {},
        request_body: JSON.stringify({ fb_api_req_friendly_name: "ProfileCometTimelineFeedRefetchQuery", doc_id: "111" }),
        timestamp: new Date().toISOString(),
      },
      {
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        response_body: "", // Empty — response was too large
        response_status: 200,
        request_headers: {},
        response_headers: {},
        request_body: JSON.stringify({ fb_api_req_friendly_name: "CometProfileAboutAppSectionQuery", doc_id: "222" }),
        timestamp: new Date().toISOString(),
      },
      {
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        response_body: "", // Empty — response was too large
        response_status: 200,
        request_headers: {},
        response_headers: {},
        request_body: JSON.stringify({ fb_api_req_friendly_name: "CometSinglePostDialogQuery", doc_id: "333" }),
        timestamp: new Date().toISOString(),
      },
    ];

    const merged = mergePassiveCaptureData(intercepted, [], [], new Map());
    // Each operation should be a separate entry because request_body distinguishes them
    expect(merged.length).toBe(3);
    const opNames = merged.map(e => {
      try { return JSON.parse(e.request_body ?? "{}").fb_api_req_friendly_name; } catch { return undefined; }
    }).filter(Boolean);
    expect(opNames).toContain("ProfileCometTimelineFeedRefetchQuery");
    expect(opNames).toContain("CometProfileAboutAppSectionQuery");
    expect(opNames).toContain("CometSinglePostDialogQuery");
  });

  it("interceptor entries with empty response_body are extracted as endpoints by extractEndpoints", () => {
    // After the fix: entries with empty response_body (large response) should still be indexed
    // because extractEndpoints handles missing response bodies via the GraphQL synthetic fallback
    const intercepted = [
      {
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        response_body: "",
        response_status: 200,
        request_headers: {},
        response_headers: {},
        request_body: JSON.stringify({ fb_api_req_friendly_name: "ProfileCometTimelineFeedRefetchQuery", doc_id: "111" }),
        timestamp: new Date().toISOString(),
      },
      {
        url: "https://www.facebook.com/api/graphql/",
        method: "POST",
        response_body: "",
        response_status: 200,
        request_headers: {},
        response_headers: {},
        request_body: JSON.stringify({ fb_api_req_friendly_name: "CometProfileAboutAppSectionQuery", doc_id: "222" }),
        timestamp: new Date().toISOString(),
      },
    ];

    const requests = mergePassiveCaptureData(intercepted, [], [], new Map());
    expect(requests.length).toBe(2);

    const endpoints = extractEndpoints(requests, undefined, {
      pageUrl: "https://www.facebook.com/NASA/",
    });
    expect(endpoints.length).toBeGreaterThanOrEqual(2);
    const opNames = endpoints.map(e => e.graphql_info?.operation_name).filter(Boolean);
    expect(opNames).toContain("ProfileCometTimelineFeedRefetchQuery");
    expect(opNames).toContain("CometProfileAboutAppSectionQuery");
  });
});
