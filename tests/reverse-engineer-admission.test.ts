import { describe, expect, it } from "bun:test";
import { extractEndpoints } from "../src/reverse-engineer/index.js";
import type { RawRequest } from "../src/capture/index.js";

function makeRequest(overrides: Partial<RawRequest>): RawRequest {
  return {
    url: "https://example.com/api/search?q=openai",
    method: "GET",
    request_headers: {},
    response_status: 200,
    response_headers: {},
    response_body: '{"items":[{"id":"1","name":"OpenAI"}]}',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("reverse engineer parsed-body admission", () => {
  it("keeps JSON responses", () => {
    const endpoints = extractEndpoints([makeRequest({})], undefined, { pageUrl: "https://example.com/search?q=openai" });
    expect(endpoints.length).toBe(1);
  });

  it("drops css/js-like text responses even when path looks api-like", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        response_body: "body{color:red}.card{display:flex}",
      }),
    ], undefined, { pageUrl: "https://example.com/search?q=openai" });
    expect(endpoints.length).toBe(0);
  });

  it("keeps real HTML responses", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://example.com/search?q=openai",
        response_body: "<html><body><main><div class='result'>OpenAI</div></main></body></html>",
      }),
    ], undefined, { pageUrl: "https://example.com/search?q=openai" });
    expect(endpoints.length).toBe(1);
  });

  it("normalizes indexed query params into templated binding names", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://example.com/api/search?filters[0][value]=sf&filters[1][value]=eng",
      }),
    ], undefined, {
      pageUrl: "https://example.com/search?filters[0][value]=sf&filters[1][value]=eng",
      intent: "search jobs",
    });
    expect(endpoints.length).toBe(1);
    expect(endpoints[0]?.url_template).toBe(
      "https://example.com/api/search?filters%5B0%5D%5Bvalue%5D={filters_0_value}&filters%5B1%5D%5Bvalue%5D={filters_1_value}",
    );
    expect(endpoints[0]?.query).toEqual({
      "filters[0][value]": "sf",
      "filters[1][value]": "eng",
    });
  });

  it("drops parsed JSON that does not match a post-search intent", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://mastodon.social/api/v1/trends/tags",
        response_body: '[{"name":"openai","history":[{"day":"1","accounts":"10"}]}]',
      }),
    ], undefined, {
      pageUrl: "https://mastodon.social/search?q=openai",
      intent: "search posts",
    });
    expect(endpoints.length).toBe(0);
  });

  it("drops parsed JSON that does not match a people-search intent", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://www.linkedin.com/voyager/api/voyagerLaunchpadDashLaunchpadViews?q=people",
        response_body: '{"elements":[{"entityUrn":"urn:li:launchpad:1","trackingId":"abc"}],"paging":{"count":10}}',
      }),
    ], undefined, {
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=openai",
      intent: "search people",
    });
    expect(endpoints.length).toBe(0);
  });

  it("drops parsed JSON for global-nav/feed payloads during people search", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashGlobalNavs.123",
        response_body: '{"data":{"viewer":{"urn":"urn:li:fsd_profile:abc"}},"extensions":{"included":[{"navigationItems":[]}]} }',
      }),
    ], undefined, {
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=openai",
      intent: "search people",
    });
    expect(endpoints.length).toBe(0);
  });

  it("keeps linkedin main feed payloads for get feed posts intent", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://www.linkedin.com/voyager/api/graphql?variables=(start:0,count:3,sortOrder:MEMBER_SETTING)&queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
        response_body: JSON.stringify({
          data: {
            elements: [
              {
                actor: { name: { text: "Lewis" } },
                socialDetail: { totalSocialActivityCounts: { numLikes: 5, numComments: 2 } },
              },
            ],
            paging: { count: 3, start: 0 },
          },
        }),
      }),
    ], undefined, {
      pageUrl: "https://www.linkedin.com/feed/",
      intent: "get feed posts",
    });
    expect(endpoints.length).toBe(1);
    expect(endpoints[0]?.url_template).toContain("voyagerFeedDashMainFeed");
  });

  it("keeps parsed JSON that matches a people-search intent", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://www.linkedin.com/voyager/api/search/cluster?keywords=openai",
        response_body: '{"elements":[{"publicIdentifier":"sam-altman","firstName":"Sam","lastName":"Altman","headline":"CEO at OpenAI"}]}',
      }),
    ], undefined, {
      pageUrl: "https://www.linkedin.com/search/results/people/?keywords=openai",
      intent: "search people",
    });
    expect(endpoints.length).toBe(1);
  });

  it("keeps parsed X-style user payloads for profile intent", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://x.com/i/api/graphql/abc/UsersByRestIds?variables=%7B%7D&features=%7B%7D",
        response_body: '{"data":{"users":{"result":[{"rest_id":"123","core":{"screen_name":"openai","name":"OpenAI"},"legacy":{"description":"AI company","followers_count":1}}]}}}',
      }),
    ], undefined, {
      pageUrl: "https://x.com",
      intent: "get user profile",
    });
    expect(endpoints.length).toBe(1);
  });

  it("treats JSON with embedded html fields as JSON, not html", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        url: "https://mastodon.social/api/v2/search?q=openai&resolve=false&limit=11",
        response_body: '{"accounts":[],"statuses":[{"content":"<p>OpenAI shipped</p>","replies_count":1,"favourites_count":2}],"hashtags":[]}',
      }),
    ], undefined, {
      pageUrl: "https://mastodon.social/search?q=openai",
      intent: "search posts",
    });
    expect(endpoints.length).toBe(1);
  });

  it("templatizes action request bodies into replayable body params", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        method: "POST",
        url: "https://practice.expandtesting.com/notes/api/notes",
        request_body: JSON.stringify({
          title: "hello",
          description: "world",
          completed: false,
        }),
        response_body: JSON.stringify({
          id: "note-1",
          title: "hello",
          description: "world",
          completed: false,
        }),
      }),
    ], undefined, {
      pageUrl: "https://practice.expandtesting.com/notes/app",
      intent: "create note",
    });

    expect(endpoints.length).toBe(1);
    expect(endpoints[0]?.body).toEqual({
      title: "{title}",
      description: "{description}",
      completed: false,
    });
    expect(endpoints[0]?.body_params).toEqual({
      title: "hello",
      description: "world",
    });
  });

  it("infers csrf plan from cookie-backed csrf headers", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        method: "POST",
        url: "https://example.com/api/notes",
        request_headers: {
          cookie: "session=abc; csrftoken=token-123",
          "x-csrftoken": "token-123",
          "content-type": "application/json",
        },
        request_body: JSON.stringify({ title: "hello" }),
        response_body: JSON.stringify({ ok: true, id: "1" }),
      }),
    ], undefined, {
      pageUrl: "https://example.com/notes",
      intent: "create note",
    });

    expect(endpoints.length).toBe(1);
    expect(endpoints[0]?.csrf_plan).toEqual({
      source: "cookie",
      param_name: "x-csrftoken",
      refresh_on_401: true,
      extractor_sequence: ["csrftoken"],
    });
    expect(endpoints[0]?.semantic?.auth_required).toBe(true);
  });

  it("preserves GraphQL POST body (operationName, query, variables) — issue #392", () => {
    const graphqlBody = JSON.stringify({
      operationName: "FeedPost",
      query: "query FeedPost($id: ID!) { post(id: $id) { title body } }",
      variables: { id: "abc-123" },
    });
    const endpoints = extractEndpoints([
      makeRequest({
        method: "POST",
        url: "https://gql.reddit.com/svc/shreddit/graphql",
        request_headers: { "content-type": "application/json" },
        request_body: graphqlBody,
        response_body: JSON.stringify({ data: { post: { title: "Hello", body: "World" } } }),
      }),
    ], undefined, {
      pageUrl: "https://www.reddit.com/r/singularity",
    });

    expect(endpoints.length).toBe(1);
    const ep = endpoints[0]!;
    // The body must contain the GraphQL fields, not be empty {}
    expect(ep.body).toBeDefined();
    expect(ep.body).not.toEqual({});
    expect(ep.body?.operationName ?? ep.body_params?.operationName).toBeDefined();
    expect(ep.body?.query ?? ep.body_params?.query).toBeDefined();
    expect(ep.body?.variables ?? ep.body_params?.variables).toBeDefined();
  });

  it("creates separate endpoints for different GraphQL operations on same URL — issue #392", () => {
    const endpoints = extractEndpoints([
      makeRequest({
        method: "POST",
        url: "https://gql.reddit.com/svc/shreddit/graphql",
        request_headers: { "content-type": "application/json" },
        request_body: JSON.stringify({
          operationName: "FeedPost",
          query: "query FeedPost($id: ID!) { post(id: $id) { title } }",
          variables: { id: "abc" },
        }),
        response_body: JSON.stringify({ data: { post: { title: "Hello" } } }),
      }),
      makeRequest({
        method: "POST",
        url: "https://gql.reddit.com/svc/shreddit/graphql",
        request_headers: { "content-type": "application/json" },
        request_body: JSON.stringify({
          operationName: "SubredditAbout",
          query: "query SubredditAbout($name: String!) { subreddit(name: $name) { description } }",
          variables: { name: "singularity" },
        }),
        response_body: JSON.stringify({ data: { subreddit: { description: "AI news" } } }),
      }),
    ], undefined, {
      pageUrl: "https://www.reddit.com/r/singularity",
    });

    // Both operations should produce separate endpoints
    expect(endpoints.length).toBe(2);
  });

  it("preserves GraphQL POST body when response body is missing — issue #392", () => {
    const graphqlBody = JSON.stringify({
      operationName: "GetPostsFeed",
      query: "query GetPostsFeed($first: Int) { posts(first: $first) { edges { node { id title } } } }",
      variables: { first: 20 },
    });
    const endpoints = extractEndpoints([
      makeRequest({
        method: "POST",
        url: "https://www.producthunt.com/frontend/graphql",
        request_headers: { "content-type": "application/json" },
        request_body: graphqlBody,
        // Response body missing/empty — triggers synthetic body path
        response_body: undefined,
      }),
    ], undefined, {
      pageUrl: "https://www.producthunt.com",
    });

    expect(endpoints.length).toBe(1);
    const ep = endpoints[0]!;
    expect(ep.body).toBeDefined();
    expect(ep.body).not.toEqual({});
    // At minimum, query and operationName should be in the body
    expect(ep.body?.operationName ?? ep.body_params?.operationName).toBeDefined();
    expect(ep.body?.query ?? ep.body_params?.query).toBeDefined();
  });
});
