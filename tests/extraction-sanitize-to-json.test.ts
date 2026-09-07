// Lewis 2026-05-21: "make postprocess step to convert it to json
// regardless. json should sanitize html to markdown where relevant,
// tables turned into json".
//
// sanitizeExtractionToJson walks the extraction output; for string
// values containing HTML, it (a) replaces a whole-string-is-a-table
// with the parsed JSON array, or (b) converts other HTML to markdown.
// Existing JSON shapes pass through unchanged.
//
// Real-runtime: live extractFromDOM, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOM, sanitizeExtractionToJson } from "../src/extraction/index.js";

describe("post-process: sanitizeExtractionToJson", () => {
  test("plain JSON value passes through unchanged", () => {
    const input = { title: "Plain text", count: 42, list: ["a", "b", "c"] };
    expect(sanitizeExtractionToJson(input)).toEqual(input);
  });

  test("HTML in string values is converted to markdown", () => {
    const input = { body: "<h1>Welcome</h1><p>Read the <a href='/docs'>docs</a> for more.</p>" };
    const out = sanitizeExtractionToJson(input) as { body: string };
    expect(out.body).toMatch(/# Welcome/);
    expect(out.body).toMatch(/\[docs\]\(\/docs\)/);
    // No raw HTML tags remain.
    expect(out.body).not.toMatch(/<h1>|<\/h1>|<p>|<a /);
  });

  test("whole-string-is-a-table converts to JSON array", () => {
    const tableHtml = `
      <table>
        <thead><tr><th>Name</th><th>Score</th></tr></thead>
        <tbody>
          <tr><td>Alice</td><td>95</td></tr>
          <tr><td>Bob</td><td>88</td></tr>
          <tr><td>Carol</td><td>76</td></tr>
        </tbody>
      </table>`;
    const input = { results: tableHtml };
    const out = sanitizeExtractionToJson(input) as { results: Array<Record<string, string>> };
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.results.length).toBe(3);
    expect(out.results[0].Name).toBe("Alice");
    expect(out.results[0].Score).toBe("95");
    expect(out.results[2].Name).toBe("Carol");
  });

  test("nested HTML strings inside arrays are sanitised", () => {
    const input = {
      posts: [
        { title: "First", body: "<p>Paragraph <strong>one</strong>.</p>" },
        { title: "Second", body: "<ul><li>item a</li><li>item b</li></ul>" },
      ],
    };
    const out = sanitizeExtractionToJson(input) as { posts: Array<{ title: string; body: string }> };
    expect(out.posts[0].body).toMatch(/\*\*one\*\*/);
    expect(out.posts[1].body).toMatch(/- item a/);
    expect(out.posts[0].title).toBe("First");
  });

  test("extractFromDOM end-to-end: sanitised return shape", () => {
    // The extractor's metadata-fallback returns {title, description}
    // — both plain strings. Should pass through unchanged.
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="A simple page">
      <meta property="og:description" content="A short description.">
    </head><body></body></html>`;
    const r = extractFromDOM(html, "get page info");
    expect((r.data as Record<string, string>).title).toBe("A simple page");
    expect((r.data as Record<string, string>).description).toBe("A short description.");
  });

  test("script and style tags are stripped from HTML strings", () => {
    const input = { content: "<p>Real text</p><script>alert('xss')</script><style>.x{color:red}</style>" };
    const out = sanitizeExtractionToJson(input) as { content: string };
    expect(out.content).toMatch(/Real text/);
    expect(out.content).not.toMatch(/alert|color:red/);
  });
});
