import { describe, it, expect } from "bun:test";
import { rankEndpoints } from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

function ep(url: string, extra: Partial<EndpointDescriptor> = {}): EndpointDescriptor {
  return {
    endpoint_id: url,
    url_template: url,
    method: "GET",
    idempotency: "safe",
    ...extra,
  } as EndpointDescriptor;
}

describe("cross-entity segment mismatch penalty", () => {
  it("demotes r/programming endpoint when context is r/singularity", () => {
    const endpoints = [
      ep("https://reddit.com/r/programming/hot.json"),
      ep("https://reddit.com/r/{subreddit}/hot.json"),
    ];
    const ranked = rankEndpoints(
      endpoints,
      "hot posts",
      "reddit.com",
      "https://reddit.com/r/singularity",
    );
    const templateIdx = ranked.findIndex((r) => r.endpoint.url_template.includes("{subreddit}"));
    const hardcodedIdx = ranked.findIndex((r) => r.endpoint.url_template.includes("/programming/"));
    expect(templateIdx).toBeLessThan(hardcodedIdx);
  });

  it("does not penalize template endpoint for placeholder segments", () => {
    const endpoints = [
      ep("https://reddit.com/r/{subreddit}/hot.json"),
    ];
    const ranked = rankEndpoints(
      endpoints,
      "hot posts",
      "reddit.com",
      "https://reddit.com/r/singularity",
    );
    expect(ranked.length).toBe(1);
    // Score should not be dragged negative by false mismatch on {subreddit}
    expect(ranked[0].score).toBeGreaterThan(-100);
  });

  it("does not penalize when concrete segments all match", () => {
    const endpoints = [
      ep("https://reddit.com/r/programming/hot.json"),
    ];
    const ranked = rankEndpoints(
      endpoints,
      "hot posts",
      "reddit.com",
      "https://reddit.com/r/programming",
    );
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it("penalizes each mismatched segment independently", () => {
    const singleMismatch = ep("https://example.com/users/alice/posts");
    const doubleMismatch = ep("https://example.com/users/bob/comments");
    const ranked = rankEndpoints(
      [singleMismatch, doubleMismatch],
      "posts",
      "example.com",
      "https://example.com/users/alice/posts",
    );
    const aliceIdx = ranked.findIndex((r) => r.endpoint.url_template.includes("alice"));
    const bobIdx = ranked.findIndex((r) => r.endpoint.url_template.includes("bob"));
    expect(aliceIdx).toBeLessThan(bobIdx);
  });
});
