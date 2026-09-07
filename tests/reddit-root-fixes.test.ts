import { describe, expect, it } from "bun:test";
import { materializeRealWorldCase } from "../evals/real-world-cases.js";
import { buildPageArtifactCapture, deriveStructuredDataReplayCandidates, deriveStructuredDataReplayUrl } from "../src/execution/index.js";

describe("reddit root fixes", () => {
  it("rewrites subreddit pages to canonical json", () => {
    expect(deriveStructuredDataReplayUrl("https://www.reddit.com/r/programming/")).toBe(
      "https://www.reddit.com/r/programming/.json",
    );
  });

  it("rewrites reddit search pages to search.json", () => {
    expect(deriveStructuredDataReplayUrl("https://www.reddit.com/search/?q=openai")).toBe(
      "https://www.reddit.com/search.json?q=openai",
    );
  });

  it("adds old reddit as a structured replay fallback candidate", () => {
    expect(deriveStructuredDataReplayCandidates("https://www.reddit.com/r/programming/")).toEqual([
      "https://www.reddit.com/r/programming/.json",
      "https://old.reddit.com/r/programming/.json",
    ]);
  });

  it("drops impossible root-only comment evals", () => {
    expect(materializeRealWorldCase({
      id: "reddit-comments",
      domain: "reddit.com",
      url: "https://www.reddit.com",
      intent: "get post comments",
      auth: false,
      expected_fields: ["author", "body"],
    })).toBeNull();
  });

  it("rejects sidebar-like reddit page artifacts for subreddit posts", () => {
    expect(
      buildPageArtifactCapture(
        "https://www.reddit.com/r/programming/",
        "get subreddit posts",
        "<main><aside><div class='item'>Home</div><div class='item'>Popular</div><div class='item'>All</div></aside></main>",
      ).endpoint,
    ).toBeUndefined();
  });
});
