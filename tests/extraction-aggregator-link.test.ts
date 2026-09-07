// Regression test: aggregator/forum sites (lobste.rs, HN, reddit) put a vote
// or login link FIRST inside each story card. The naive "use links[0]" rule
// gave every card the same href (e.g. /login on lobste.rs), which the
// diversity check correctly rejected as nav chrome — leaving structurally
// extractable sites in the PRODUCT_FAIL bucket.
//
// The fix in extractCardFields prefers (1) <a class="u-url"> microformats
// hint, (2) external absolute URL, (3) first non-interaction link, before
// falling back to links[0]. Title fallback prefers the chosen link's text
// over the first <a>'s text (which is usually a numeric vote count).

import { describe, expect, it } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

describe("aggregator card link selection", () => {
  it("picks the story link, not the upvote /login link, on lobste.rs-style markup", () => {
    // Minimal lobste.rs story-list shape — the upvoter <a href=/login> appears
    // before the actual story <a class="u-url" href=https://...>.
    const html = `<!doctype html><html><body>
      <ol class="stories list">
        <li id="story_a" class="story">
          <div class="story_liner h-entry">
            <div class="voters"><a class="upvoter" href="/login">12</a></div>
            <div class="details">
              <span role="heading" aria-level="1" class="link h-cite">
                <a class="u-url" href="https://blog.example.com/first-post">First Post Title</a>
              </span>
              <a class="domain" href="/domains/blog.example.com">blog.example.com</a>
            </div>
          </div>
        </li>
        <li id="story_b" class="story">
          <div class="story_liner h-entry">
            <div class="voters"><a class="upvoter" href="/login">8</a></div>
            <div class="details">
              <span role="heading" aria-level="1" class="link h-cite">
                <a class="u-url" href="https://other.example.org/second">Second Post Title</a>
              </span>
              <a class="domain" href="/domains/other.example.org">other.example.org</a>
            </div>
          </div>
        </li>
        <li id="story_c" class="story">
          <div class="story_liner h-entry">
            <div class="voters"><a class="upvoter" href="/login">3</a></div>
            <div class="details">
              <span role="heading" aria-level="1" class="link h-cite">
                <a class="u-url" href="https://third.example.net/post">Third Post Title</a>
              </span>
              <a class="domain" href="/domains/third.example.net">third.example.net</a>
            </div>
          </div>
        </li>
      </ol>
    </body></html>`;

    const result = extractFromDOM(html, "front page");
    expect(result.extraction_method).toBe("repeated-elements");
    expect(Array.isArray(result.data)).toBe(true);

    const items = result.data as Array<Record<string, string>>;
    expect(items.length).toBe(3);

    // Each item must have the EXTERNAL story URL, not /login
    const links = items.map((i) => i.link);
    expect(links).toEqual([
      "https://blog.example.com/first-post",
      "https://other.example.org/second",
      "https://third.example.net/post",
    ]);

    // Titles should come from the story link text, not the vote count
    const titles = items.map((i) => i.title);
    expect(titles).toEqual([
      "First Post Title",
      "Second Post Title",
      "Third Post Title",
    ]);
  });

  it("falls back gracefully when there is no microformats / external link", () => {
    // Pure-internal aggregator: every link is on the same host. The
    // non-interaction filter should still beat the upvote link.
    const html = `<!doctype html><html><body>
      <ul class="posts">
        <li class="post"><a href="/upvote/1">+</a><a href="/p/aaa">AAA</a></li>
        <li class="post"><a href="/upvote/2">+</a><a href="/p/bbb">BBB</a></li>
        <li class="post"><a href="/upvote/3">+</a><a href="/p/ccc">CCC</a></li>
      </ul>
    </body></html>`;

    const result = extractFromDOM(html, "posts");
    expect(result.extraction_method).toBe("repeated-elements");
    const items = result.data as Array<Record<string, string>>;
    const links = items.map((i) => i.link);
    expect(links).toEqual(["/p/aaa", "/p/bbb", "/p/ccc"]);
  });
});
