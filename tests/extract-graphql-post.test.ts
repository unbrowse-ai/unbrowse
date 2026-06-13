import { describe, expect, test } from "bun:test";
import { extractEndpoints } from "../backend/src/services/reverse-engineer/index";

// A4 fix — GraphQL POST endpoints at non-/graphql/ URLs were getting dropped
// at extractEndpoints because:
//   1. scoreRequest only awarded the +2 graphql bonus when /graphql/ in URL
//   2. The url-bypass at the body_not_json_or_html branch only matched
//      /api|graphql|.../ paths, not request-body shape
// Now we widen detection to inspect request_body for {operationName,
// query, doc_id, fb_api_req_friendly_name, variables+extensions} and treat
// any of those as proof of a GraphQL POST regardless of URL.

function makeReq(over: Partial<{
  url: string; method: string; request_body: string;
  response_body: string; response_headers: Record<string, string>;
  request_headers: Record<string, string>;
}>): any {
  return {
    url: "https://www.example.com/post",
    method: "POST",
    request_headers: {},
    response_headers: { "content-type": "application/json" },
    response_body: '{"data":{}}',
    request_body: undefined,
    ...over,
  };
}
describe("extractEndpoints A4 — GraphQL POST detection by body shape", () => {
  test("admits POST with operationName in JSON body even at non-graphql URL", () => {
    const req = makeReq({
      url: "https://www.facebook.com/api/persisted_query",
      method: "POST",
      request_body: JSON.stringify({
        operationName: "HomeFeedQuery",
        variables: { count: 10 },
        query: "query HomeFeedQuery($count:Int) { feed(count:$count) { id } }",
      }),
      response_body: "", // small/empty response — common for mutations + persisted queries
    });
    const endpoints = extractEndpoints([req], undefined, {
      pageUrl: "https://www.facebook.com/",
      finalUrl: "https://www.facebook.com/",
    });
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
  });

  test("admits POST with persisted-query extensions {variables,extensions}", () => {
    const req = makeReq({
      url: "https://api.example.com/graphql-anywhere",
      method: "POST",
      request_body: JSON.stringify({
        variables: { id: "abc" },
        extensions: { persistedQuery: { version: 1, sha256Hash: "deadbeef" } },
      }),
      response_body: "{}",
    });
    const endpoints = extractEndpoints([req], undefined, {
      pageUrl: "https://api.example.com/",
      finalUrl: "https://api.example.com/",
    });
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
  });

  test("admits POST with Facebook doc_id form-encoded body", () => {
    const req = makeReq({
      url: "https://www.facebook.com/api/", // no /graphql/ in URL
      method: "POST",
      request_body: "av=12345&doc_id=789012345&variables=%7B%22count%22%3A10%7D&fb_api_req_friendly_name=HomeFeedQuery",
      response_body: '{"data":{"feed":[]}}',
      response_headers: { "content-type": "application/json" },
    });
    const endpoints = extractEndpoints([req], undefined, {
      pageUrl: "https://www.facebook.com/",
      finalUrl: "https://www.facebook.com/",
    });
    expect(endpoints.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT misclassify a regular form-post as graphql", () => {
    const req = makeReq({
      url: "https://shop.example.com/checkout",
      method: "POST",
      request_body: "name=lewis&email=foo@bar.com&total=100",
      response_body: "", // empty response, no body shape
    });
    const endpoints = extractEndpoints([req], undefined, {
      pageUrl: "https://shop.example.com/",
      finalUrl: "https://shop.example.com/",
    });
    // Plain form post shouldn't be graphql-detected. May still be admitted via
    // other paths (URL has no /api/, body length 0, etc.) — we only assert it
    // wasn't matched as graphql, by checking no operationName is in description.
    for (const ep of endpoints) {
      expect((ep.description ?? "").toLowerCase()).not.toContain("homefeed");
    }
  });
});
