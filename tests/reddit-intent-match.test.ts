import { describe, expect, it } from "bun:test";
import { assessIntentResult } from "../src/intent-match.js";

describe("reddit intent matching", () => {
  it("accepts subreddit listing json as subreddit posts", () => {
    const result = assessIntentResult({
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: "abc123",
              title: "Ask HN: best tools?",
              author: "pg",
              subreddit: "programming",
              score: 42,
              num_comments: 8,
              permalink: "/r/programming/comments/abc123/ask_hn_best_tools/",
            },
          },
        ],
      },
    }, "get subreddit posts");

    expect(result.verdict).toBe("pass");
    expect(Array.isArray(result.projected)).toBe(true);
    expect((result.projected as Array<Record<string, unknown>>)[0]?.title).toBe("Ask HN: best tools?");
  });

  it("accepts reddit search listing json as search results", () => {
    const result = assessIntentResult({
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: "def456",
              title: "OpenAI launches new model",
              author: "sama",
              subreddit: "MachineLearning",
              score: 99,
              num_comments: 17,
              permalink: "/r/MachineLearning/comments/def456/openai_launches_new_model/",
            },
          },
        ],
      },
    }, "search reddit");

    expect(result.verdict).toBe("pass");
    expect(Array.isArray(result.projected)).toBe(true);
    expect((result.projected as Array<Record<string, unknown>>)[0]?.subreddit).toBe("MachineLearning");
  });

  it("accepts reddit comments json as post comments", () => {
    const result = assessIntentResult([
      {
        kind: "Listing",
        data: { children: [] },
      },
      {
        kind: "Listing",
        data: {
          children: [
            {
              kind: "t1",
              data: {
                id: "ghi789",
                author: "knuth",
                body: "good thread",
                permalink: "/r/programming/comments/abc123/ask_hn_best_tools/ghi789/",
              },
            },
          ],
        },
      },
    ], "get post comments");

    expect(result.verdict).toBe("pass");
    expect(Array.isArray(result.projected)).toBe(true);
    expect((result.projected as Array<Record<string, unknown>>)[0]?.body).toBe("good thread");
  });
});
