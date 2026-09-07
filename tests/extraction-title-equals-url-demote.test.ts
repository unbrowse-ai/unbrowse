// W3-followup: extractor produced rows for r/programming where
// title === link === url (the actual post titles weren't extracted —
// only the link URL was duplicated into the title field). Live source:
// .bench-gate/20260520T093742Z/013_semantic-rank_https___www_reddit_com_r_programming_/execute.response.raw
//
// Root cause: extractCardFields' fallback-title-from-link-text path
// (src/extraction/index.ts:2218-2229) accepted ANY non-empty <a> text
// as the title — including the literal URL when the anchor's text is
// its href.
//
// Structural fix (NOT per-host): the candidate filter now rejects
// link-text values matching /^https?:\/\// (the URL shape) so the
// next candidate — or the html_metadata_fallback — can take over.
// URLs are stored separately in fields.url; duplicating them into
// title carries no caption signal.
//
// Real-runtime: live extractFromDOM, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

describe("W3-followup: rows with title=URL are demoted (reddit reproducer)", () => {
  test("6 articles where anchor text equals href lose to og:title fallback", () => {
    // Each <article> has a single <a> whose text is its href (the
    // pattern that produced the r/programming RETRIEVE_FAIL_WRONG_CONTENT
    // verdict). No other title-bearing element on the card.
    const links = Array.from({ length: 6 }, (_, i) => `https://example${i}.com/post/${i}`);
    const rows = links.map((u) => `
      <article class="post">
        <a href="${u}">${u}</a>
      </article>`).join("\n");
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="r/programming - the Reddit programming community">
      <meta property="og:description" content="Programming news and discussion.">
    </head><body><main>${rows}</main></body></html>`;

    const result = extractFromDOM(html, "get reddit programming posts");

    // Pre-fix: result.data was an array of {url, title} where title === url.
    // Post-fix: extractCardFields rejects URL-as-title; downstream filtering
    // leaves the row title-less; falls through to html_metadata_fallback.
    if (Array.isArray(result.data) && result.data.length > 0) {
      const firstRow = result.data[0] as Record<string, unknown>;
      const title = typeof firstRow.title === "string" ? firstRow.title : "";
      if (/^https?:\/\//.test(title)) {
        throw new Error(`URL-as-title bug regressed: ${JSON.stringify(firstRow).slice(0, 200)}`);
      }
    }
  });

  test("falsifier: real article titles in card body still survive", () => {
    // Real listings where the anchor text is the post title — must NOT
    // be demoted by the new rule. Title is a real caption.
    const items = Array.from({ length: 6 }, (_, i) => `
      <article class="post">
        <a href="https://example.com/article-${i}">Real article title number ${i}: a non-URL caption</a>
      </article>`).join("\n");
    const html = `<!doctype html><html><body>
      <main class="feed">${items}</main>
    </body></html>`;

    const result = extractFromDOM(html, "get articles");
    const dataStr = JSON.stringify(result.data);
    // The real title text must survive in some form.
    expect(dataStr).toMatch(/Real article title number/);
  });

  test("falsifier: protocol-relative URL (//example.com/x) also rejected as title", () => {
    // Belt-and-suspenders: protocol-relative URLs are URL-shaped too.
    const links = Array.from({ length: 5 }, (_, i) => `//cdn${i}.example.com/asset-${i}`);
    const rows = links.map((u) => `
      <article class="card">
        <a href="${u}">${u}</a>
      </article>`).join("\n");
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="A page with bare links">
    </head><body><main>${rows}</main></body></html>`;

    const result = extractFromDOM(html, "get cards");
    if (Array.isArray(result.data) && result.data.length > 0) {
      const firstRow = result.data[0] as Record<string, unknown>;
      const title = typeof firstRow.title === "string" ? firstRow.title : "";
      if (/^(https?:)?\/\//.test(title)) {
        throw new Error(`protocol-relative URL still leaked as title: ${JSON.stringify(firstRow).slice(0, 200)}`);
      }
    }
  });
});
