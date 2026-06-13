import { describe, expect, it } from "bun:test";
import { extractEndpoints } from "../backend/src/services/reverse-engineer/index.js";
import type { RawRequest } from "../src/capture/index.js";

function makeRequest(url: string, response: unknown): RawRequest {
  return {
    url,
    method: "GET",
    request_headers: {},
    response_status: 200,
    response_headers: { "content-type": "application/json" },
    response_body: JSON.stringify(response),
    timestamp: new Date().toISOString(),
  };
}

describe("reverse engineer entity gate", () => {
  it("drops company metadata payloads for company intents", () => {
    const endpoints = extractEndpoints([
      makeRequest("https://www.linkedin.com/voyager/api/graphql/companyMetadata", {
        metadata: { trackingId: "abc" },
        included: [{ entityUrn: "urn:li:company:1", navigationContext: "foo" }],
      }),
    ], undefined, {
      pageUrl: "https://www.linkedin.com/company/openai/",
      intent: "get company info",
    });

    expect(endpoints.length).toBe(0);
  });

  it("keeps company payloads with company fields for company intents", () => {
    const endpoints = extractEndpoints([
      makeRequest("https://www.linkedin.com/voyager/api/company/openai", {
        company: {
          name: "OpenAI",
          tagline: "AI research and deployment company",
          staffCount: 5000,
          industries: ["Software"],
          websiteUrl: "https://openai.com",
        },
      }),
    ], undefined, {
      pageUrl: "https://www.linkedin.com/company/openai/",
      intent: "get company info",
    });

    expect(endpoints.length).toBe(1);
  });

  it("drops subreddit metadata for post intents", () => {
    const endpoints = extractEndpoints([
      makeRequest("https://www.reddit.com/r/programming/about.json", {
        kind: "t5",
        data: { display_name: "programming", subscribers: 1000, title: "Programming" },
      }),
    ], undefined, {
      pageUrl: "https://www.reddit.com/r/programming/",
      intent: "get subreddit posts",
    });

    expect(endpoints.length).toBe(0);
  });

  it("keeps comment payloads for comment intents", () => {
    const endpoints = extractEndpoints([
      makeRequest("https://www.reddit.com/comments/abc123.json", {
        data: {
          children: [
            {
              kind: "t1",
              body: "nice post",
              author: "lewis",
              replies: [],
              score: 12,
              permalink: "/r/programming/comments/abc123/x",
            },
          ],
        },
      }),
    ], undefined, {
      pageUrl: "https://www.reddit.com/r/programming/comments/abc123/example/",
      intent: "get post comments",
    });

    expect(endpoints.length).toBe(1);
  });
});
