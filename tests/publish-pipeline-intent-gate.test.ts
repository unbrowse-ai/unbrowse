import { describe, expect, test } from "bun:test";
import { assessIntentResult } from "../src/intent-match.js";

/**
 * Regression test for the publish pipeline bug:
 * Captures return success=false because intent-match validators reject
 * extracted data shapes as wrong_entity_type, preventing skills from
 * reaching the marketplace.
 *
 * Root cause: classifyRows has strict field expectations that don't match
 * real-world API response shapes. When intent matches a classifier keyword
 * (e.g. "posts") but the data has non-standard field names, it returns
 * verdict="fail" with reason="wrong_entity_type" — which blocks publishing.
 *
 * The fix: classifyRows should accept a wider range of field names for each
 * entity type, AND wrong_entity_type should downgrade to "skip" instead of
 * "fail" so publishing isn't blocked by field-name mismatches.
 */
describe("publish pipeline intent gate", () => {
  test("raw API post data with 'body' instead of 'text' should not fail", () => {
    const rawPosts = [
      { _id: "1", body: "Hello from API", created_time: "2026-04-01", from: { name: "User" } },
      { _id: "2", body: "Another post", created_time: "2026-04-02", from: { name: "User2" } },
    ];
    const result = assessIntentResult(rawPosts, "search posts");
    expect(result.verdict).not.toBe("fail");
  });

  test("raw Voyager-style data with entityUrn should not fail for post intent", () => {
    const rawVoyager = [
      { entityUrn: "urn:li:post:123", commentary: { text: { text: "Hello" } }, value: { text: "world" } },
      { entityUrn: "urn:li:post:456", commentary: { text: { text: "Another" } }, value: { text: "post" } },
    ];
    const result = assessIntentResult(rawVoyager, "get feed posts");
    expect(result.verdict).not.toBe("fail");
  });

  test("generic API data with 'content' field should pass post classifier", () => {
    const genericPosts = [
      { id: "1", content: "Hello world", created: "2026-04-01", likes: 10 },
      { id: "2", content: "Another one", created: "2026-04-02", likes: 5 },
    ];
    const result = assessIntentResult(genericPosts, "get posts");
    expect(result.verdict).not.toBe("fail");
  });

  test("posts with 'message' field should not fail", () => {
    const messagePosts = [
      { id: "1", message: "Hello from FB", created_time: "2026-04-01", from: { name: "User" } },
      { id: "2", message: "Second post", created_time: "2026-04-02", from: { name: "User2" } },
    ];
    const result = assessIntentResult(messagePosts, "search posts");
    expect(result.verdict).not.toBe("fail");
  });

  test("existing normalized LinkedIn feed test still passes", () => {
    const testData = {
      data: {
        data: {
          feedDashMainFeedByMainFeed: {
            "*elements": ["urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)"],
          },
        },
      },
      included: [
        {
          entityUrn: "urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)",
          commentary: { text: { text: "hello linkedin" } },
          actor: { "*profileUrn": "urn:li:fsd_profile:abc" },
          permalink: "/feed/update/urn:li:activity:1/",
          createdAt: 1772981230951,
        },
        {
          entityUrn: "urn:li:fsd_profile:abc",
          firstName: "Lewis",
          lastName: "Tham",
          publicIdentifier: "lew",
        },
      ],
    };
    const result = assessIntentResult(testData, "get feed posts");
    expect(result.verdict).toBe("pass");
  });

  test("standard post shapes still pass", () => {
    const standard = [
      { id: "1", text: "Hello", author: "user1", score: 10, created_at: "2026-04-01" },
    ];
    const result = assessIntentResult(standard, "search posts");
    expect(result.verdict).toBe("pass");
  });

  test("repos with non-standard field names should not fail", () => {
    const nonStandard = [
      { repo_name: "test", star_count: 100, description: "A test repo" },
    ];
    const result = assessIntentResult(nonStandard, "search repositories");
    // Should downgrade to skip, not fail
    expect(result.verdict).not.toBe("fail");
  });
});
