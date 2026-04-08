import { describe, expect, it } from "bun:test";
import { isReplayableApiUrl, mergePassiveCaptureData, selectPerformanceReplayCandidates } from "../src/capture/index.js";

describe("performance api replay selection", () => {
  it("keeps api-style preload urls even when page slug hints do not match", () => {
    const candidates = selectPerformanceReplayCandidates(
      [
        {
          name: "https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json",
          initiatorType: "link",
        },
        {
          name: "https://api.nusmods.com/v2/2025-2026/semesters/2/venues.json",
          initiatorType: "xmlhttprequest",
        },
        {
          name: "https://nusmods.com/manifest.json",
          initiatorType: "link",
        },
        {
          name: "https://analytics.nusmods.com/piwik.php?action_name=NUSMods",
          initiatorType: "beacon",
        },
      ],
      {
        captureUrl: "https://nusmods.com/courses/ABM5001/leadership-in-biomedicine",
        intent: "browse nusmods.com",
      },
    );

    expect(candidates).toContain("https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json");
    expect(candidates).toContain("https://api.nusmods.com/v2/2025-2026/semesters/2/venues.json");
    expect(candidates).not.toContain("https://nusmods.com/manifest.json");
    expect(candidates).not.toContain("https://analytics.nusmods.com/piwik.php?action_name=NUSMods");
  });

  it("recognizes api-ish urls without treating app manifests as replay targets", () => {
    expect(isReplayableApiUrl("https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json")).toBe(true);
    expect(isReplayableApiUrl("https://www.linkedin.com/voyager/api/identity/profiles/me")).toBe(true);
    expect(isReplayableApiUrl("https://nusmods.com/manifest.json")).toBe(false);
    expect(isReplayableApiUrl("https://analytics.nusmods.com/piwik.php")).toBe(false);
  });

  it("synthesizes request stubs for replay candidates when no body was harvested", () => {
    const merged = mergePassiveCaptureData(
      [],
      [],
      [],
      new Map(),
      ["https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json"],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.url).toBe("https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json");
    expect(merged[0]?.method).toBe("GET");
    expect(merged[0]?.response_status).toBe(200);
  });

  it("keeps multiple GraphQL operations to the same URL as separate requests — issue #392", () => {
    const graphqlUrl = "https://gql.reddit.com/svc/shreddit/graphql";
    const merged = mergePassiveCaptureData(
      [
        {
          url: graphqlUrl,
          method: "POST",
          request_headers: { "content-type": "application/json" },
          request_body: JSON.stringify({ operationName: "FeedPost", query: "query FeedPost { post { id } }", variables: {} }),
          response_status: 200,
          response_headers: { "content-type": "application/json" },
          response_body: JSON.stringify({ data: { post: { id: "1" } } }),
          timestamp: new Date().toISOString(),
        },
        {
          url: graphqlUrl,
          method: "POST",
          request_headers: { "content-type": "application/json" },
          request_body: JSON.stringify({ operationName: "SubredditAbout", query: "query SubredditAbout { subreddit { name } }", variables: {} }),
          response_status: 200,
          response_headers: { "content-type": "application/json" },
          response_body: JSON.stringify({ data: { subreddit: { name: "singularity" } } }),
          timestamp: new Date().toISOString(),
        },
      ],
      [],
      [],
      new Map(),
    );

    expect(merged.length).toBe(2);
    // Both operations should be present with their respective bodies
    const bodies = merged.map(r => JSON.parse(r.request_body!).operationName);
    expect(bodies).toContain("FeedPost");
    expect(bodies).toContain("SubredditAbout");
  });

  it("preserves GraphQL POST request body through merge — issue #392", () => {
    const graphqlUrl = "https://www.producthunt.com/frontend/graphql";
    const body = JSON.stringify({ operationName: "GetPosts", query: "query GetPosts { posts { id title } }", variables: { first: 20 } });
    const merged = mergePassiveCaptureData(
      [
        {
          url: graphqlUrl,
          method: "POST",
          request_headers: { "content-type": "application/json" },
          request_body: body,
          response_status: 200,
          response_headers: { "content-type": "application/json" },
          response_body: JSON.stringify({ data: { posts: [{ id: "1", title: "Test" }] } }),
          timestamp: new Date().toISOString(),
        },
      ],
      [],
      [],
      new Map(),
    );

    expect(merged.length).toBe(1);
    expect(merged[0]?.request_body).toBe(body);
    expect(merged[0]?.method).toBe("POST");
  });
});
