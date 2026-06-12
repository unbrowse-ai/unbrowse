// W3-followup: extractor returned the empty Redux entity bag for
// probes 020/021/022 x.com cold (no real tweets, just the empty store
// shape). The W3 config-shape demotion didn't fire because the top-
// level keys (`optimist`, `entities`) aren't in the i18n token list.
// the platform-faithful structural signal is different: every LEAF
// in this object is an empty {} or [] — there's literally no scalar
// data anywhere in the structure.
//
// Live source: .bench-gate/20260520T093742Z/021_graphql_https___x_com_elonmusk/execute.response.raw
//   {"optimist":[],"entities":{"broadcasts":{"entities":{},"errors":{},"fetchStatus":{}},
//     "cards":{"entities":{},"errors":{},"fetchStatus":{}}, ... }}
// 173KB of key-names with NO actual scalar values anywhere.
//
// Generic structural primitive: recursively count data-bearing leaves
// (non-empty strings/numbers/booleans) vs empty containers ({} and []).
// If empty-container ratio >= 0.8, the structure is a container shell
// with no payload; demote so the metadata-fallback can take over.
//
// Real-runtime: live extractFromDOM, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

function leafStats(data: unknown): { scalars: number; empties: number } {
  let scalars = 0;
  let empties = 0;
  function walk(node: unknown): void {
    if (node == null) return;
    if (Array.isArray(node)) {
      if (node.length === 0) { empties++; return; }
      for (const e of node) walk(e);
      return;
    }
    if (typeof node === "object") {
      const keys = Object.keys(node as object);
      if (keys.length === 0) { empties++; return; }
      for (const k of keys) walk((node as Record<string, unknown>)[k]);
      return;
    }
    // primitive scalar
    if (typeof node === "string" && node.trim().length === 0) { empties++; return; }
    scalars++;
  }
  walk(data);
  return { scalars, empties };
}

describe("W3-followup: empty-container demotion (x.com cold reproducer)", () => {
  test("Redux entity bag with all empty leaves loses to og:title fallback", () => {
    // Reproduce the x.com cold-capture shape: deep object where every
    // leaf is an empty {} or [].
    const emptyBag = {
      optimist: [],
      entities: {
        broadcasts: { entities: {}, errors: {}, fetchStatus: {} },
        cards: { entities: {}, errors: {}, fetchStatus: {} },
        commerceItems: { entities: {}, errors: {}, fetchStatus: {} },
        communities: { entities: {}, errors: {}, fetchStatus: {} },
        conversations: { entities: {}, errors: {}, fetchStatus: {} },
        tweets: { entities: {}, errors: {}, fetchStatus: {} },
      },
    };
    const html = `<!doctype html><html><head>
      <meta property="og:title" content="elonmusk on X">
      <meta property="og:description" content="The latest posts from @elonmusk.">
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: emptyBag } })}</script>
    </head><body></body></html>`;

    const result = extractFromDOM(html, "get x posts");

    // The empty container must not be the result. Either metadata-fallback
    // returns og:title, or some other non-empty extractor wins, but the
    // returned data must contain at least one scalar.
    const stats = leafStats(result.data);
    if (stats.scalars === 0 && stats.empties >= 3) {
      throw new Error(`empty container dominated extraction: ${JSON.stringify(result.data).slice(0, 300)}`);
    }
  });

  test("falsifier: object with mostly real data is NOT demoted", () => {
    // Real listings — mostly scalar leaves — must survive.
    const bundle = {
      props: {
        pageProps: {
          posts: [
            { id: 1, title: "First post", body: "Real content here", date: "2026-05-21", author: "alice" },
            { id: 2, title: "Second post", body: "More real content", date: "2026-05-20", author: "bob" },
            { id: 3, title: "Third post", body: "Even more content", date: "2026-05-19", author: "carol" },
          ],
        },
      },
    };
    const html = `<!doctype html><html><head>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(bundle)}</script>
    </head><body></body></html>`;

    const result = extractFromDOM(html, "get blog posts");
    const dataStr = JSON.stringify(result.data);
    // Real titles must survive into output.
    expect(dataStr).toMatch(/First post|Second post|Third post/);
  });

  test("falsifier: sparse object with a single real scalar survives", () => {
    // Borderline: a single real scalar plus many empty containers must
    // NOT be demoted (the gate at 80% empty-ratio is conservative).
    const bundle = {
      title: "Real title here",
      lists: {},
      cards: {},
      moments: {},
    };
    const html = `<!doctype html><html><head>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: bundle } })}</script>
    </head><body></body></html>`;

    const result = extractFromDOM(html, "get page title");
    const dataStr = JSON.stringify(result.data);
    expect(dataStr).toMatch(/Real title here/);
  });
});
