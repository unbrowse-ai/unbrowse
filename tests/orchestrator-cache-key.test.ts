import { describe, expect, test } from "bun:test";
import { buildResolveCacheKey } from "../src/orchestrator/index.js";

describe("buildResolveCacheKey", () => {
  test("distinguishes x root tasks by concrete route context", () => {
    const search = buildResolveCacheKey(
      "x.com",
      "search tweets",
      "https://x.com/search?q=openai&src=typed_query&f=live",
    );
    const profile = buildResolveCacheKey(
      "x.com",
      "get user profile",
      "https://x.com/OpenAI",
    );
    const trending = buildResolveCacheKey(
      "x.com",
      "get trending topics",
      "https://x.com/explore/tabs/trending",
    );

    expect(search).not.toBe(profile);
    expect(profile).not.toBe(trending);
    expect(search).not.toBe(trending);
  });

  test("keeps semantic query params but drops noisy ones", () => {
    const a = buildResolveCacheKey(
      "www.linkedin.com",
      "search people",
      "https://www.linkedin.com/search/results/people/?keywords=openai&trk=foo",
    );
    const b = buildResolveCacheKey(
      "www.linkedin.com",
      "search people",
      "https://www.linkedin.com/search/results/people/?keywords=openai&trk=bar",
    );
    const c = buildResolveCacheKey(
      "www.linkedin.com",
      "search people",
      "https://www.linkedin.com/search/results/people/?keywords=anthropic&trk=bar",
    );

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
