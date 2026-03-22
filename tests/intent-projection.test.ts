import { describe, expect, it } from "bun:test";
import { projectResultForIntent } from "../src/execution/index.js";

describe("intent-based result projection", () => {
  it("projects statuses for post intents", () => {
    const projected = projectResultForIntent({
      accounts: [{ username: "a" }],
      statuses: [{ id: "1", content: "hello", url: "https://example.com/1" }],
      hashtags: [{ name: "openai" }],
    }, "search posts");

    expect(Array.isArray(projected)).toBe(true);
    expect((projected as Array<Record<string, string>>)[0]?.content).toBe("hello");
  });

  it("projects accounts for people intents", () => {
    const projected = projectResultForIntent({
      statuses: [{ id: "1" }],
      accounts: [{ username: "sam", display_name: "Sam Altman" }],
    }, "search people");

    expect(Array.isArray(projected)).toBe(true);
    expect((projected as Array<Record<string, string>>)[0]?.username).toBe("sam");
  });

  it("counts reviews mentioning a quoted term", () => {
    const projected = projectResultForIntent([
      { author: "A", body: "I was disappointed by the battery life", rating: "2" },
      { author: "B", body: "disappointed with the fit", rating: "3" },
      { author: "C", body: "works great", rating: "5" },
    ], 'Get the total number of reviews that our store received so far that mention term "disappointed"');

    expect(projected).toEqual([2]);
  });

  it("returns top search terms for search-term intents", () => {
    const projected = projectResultForIntent([
      { term: "hollister" },
      { term: "Joust Bag" },
      { term: "Radiant Tee" },
    ], "Get the top 2 search term(s) in my store");

    expect(projected).toEqual(["hollister", "Joust Bag"]);
  });

  it("returns matching reviewer names with rating filters", () => {
    const projected = projectResultForIntent([
      { author: "Taylor", body: "The print quality is rough around the edges", rating: "3" },
      { author: "Jordan", body: "The print quality looks fantastic", rating: "5" },
      { author: "Casey", body: "print quality is poor and blurry", rating: "2" },
    ], "Get name(s) of reviewer(s) who mention print quality explicitly with a rating of 3 or less stars for the product on the current page");

    expect(projected).toEqual(["Taylor", "Casey"]);
  });

  it("matches reviewer intents with token overlap when phrasing differs", () => {
    const projected = projectResultForIntent([
      { author: "Catso", body: "they really are for people with very small ears", rating: "1" },
      { author: "Dibbins", body: "the ear cups are way too small for adult sized ears", rating: "3" },
      { author: "Anglebert Dinkherhump", body: "these are not over the ear cups and i got about half my ear into it; they get small for travel", rating: "4" },
      { author: "Michelle DavisMichelle Davis", body: "for small ears the padding goes over their ears", rating: "5" },
      { author: "Joseph Brzezinski", body: "over ear with disappointing sound quality", rating: "5" },
    ], "Get name(s) of reviewer(s) who mention ear cups being small for the product on the current page");

    expect(projected).toEqual([
      "Catso",
      "Dibbins",
      "Anglebert Dinkherhump",
      "Michelle DavisMichelle Davis",
    ]);
  });

  it("returns forum post author, title, and negative-comment count from comment rows", () => {
    const projected = projectResultForIntent([
      { author: "alice", body: "great", score: "4", post_author: "ziostraccette", post_title: "How can I bring an HDMI cable from my pc downstairs to my TV upstairs?" },
      { author: "bob", body: "bad", score: "-2", post_author: "ziostraccette", post_title: "How can I bring an HDMI cable from my pc downstairs to my TV upstairs?" },
      { author: "ziostraccette", body: "thanks", score: "-5", post_author: "ziostraccette", post_title: "How can I bring an HDMI cable from my pc downstairs to my TV upstairs?" },
    ], 'In the DIY forum, get the username and post title of the most recent post, and count the number of comments on that post that are not from the author and have more downvotes than upvotes. Return a list of objects with keys "username", "post_title", and "count".');

    expect(projected).toEqual([{
      username: "ziostraccette",
      post_title: "How can I bring an HDMI cable from my pc downstairs to my TV upstairs?",
      count: 1,
    }]);
  });
});
