import { describe, expect, it } from "bun:test";
import { extractFromDOM, extractSPAData } from "../src/extraction/index.js";

/**
 * Covers the silent-truncation and non-greedy-regex bugs fixed in the
 * harness-harness iteration. Every test here is a regression gate for
 * a real extraction failure observed on the audit corpus.
 */

describe("extractSPAData: SPA payload parsing", () => {
  it("parses __NEXT_DATA__ past the 300K truncation boundary", () => {
    // Simulate coinmarketcap: huge HTML with __NEXT_DATA__ well past byte 300K.
    const filler = "<!-- " + "x".repeat(400_000) + " -->";
    const payload = JSON.stringify({
      props: {
        pageProps: {
          detailRes: { detail: { statistics: { price: 72868.85 } } },
          symbol: "BTC",
        },
      },
    });
    const html = `<html><body>${filler}<script id="__NEXT_DATA__" type="application/json">${payload}</script></body></html>`;
    const spa = extractSPAData(html);
    expect(spa.length).toBe(1);
    expect(spa[0].type).toBe("spa-nextjs");
    const data = spa[0].data as Record<string, unknown>;
    expect((data.detailRes as any).detail.statistics.price).toBe(72868.85);
    // The end-to-end extractor also surfaces spa-nextjs as the chosen method.
    const extracted = extractFromDOM(html, "get bitcoin price");
    expect(extracted.extraction_method).toBe("spa-nextjs");
  });

  it("brace-balanced parser handles nested window.__NUXT__ payload", () => {
    // The old non-greedy regex truncated at the first inner `}`, losing
    // all nested structure. A real Nuxt state tree has at least one level
    // of nesting, usually many.
    const payload = JSON.stringify({
      state: {
        products: {
          list: [{ id: 1, name: "one" }, { id: 2, name: "two" }],
          total: 2,
        },
      },
    });
    const html = `<html><body><script>window.__NUXT__=${payload}</script></body></html>`;
    const spa = extractSPAData(html);
    expect(spa.length).toBe(1);
    expect(spa[0].type).toBe("spa-nuxt");
    const data = spa[0].data as Record<string, unknown>;
    expect((data.products as any).total).toBe(2);
    expect((data.products as any).list.length).toBe(2);
  });

  it("parses __APOLLO_STATE__ with deeply nested cache keys", () => {
    // Goodreads-class: Apollo Client cache with Book:{id} entries.
    const payload = JSON.stringify({
      ROOT_QUERY: { __typename: "Query" },
      "Book:3735293": {
        __typename: "Book",
        title: "Harry Potter",
        author: { __ref: "Author:1077326" },
        details: { pages: 309, language: "en" },
      },
      "Author:1077326": { __typename: "Author", name: "J.K. Rowling" },
    });
    const html = `<script>window.__APOLLO_STATE__=${payload}</script>`;
    const spa = extractSPAData(html);
    expect(spa.length).toBe(1);
    expect(spa[0].type).toBe("spa-initial-state");
    const data = spa[0].data as Record<string, unknown>;
    expect((data["Book:3735293"] as any).title).toBe("Harry Potter");
  });

  it("ignores mangled SPA payloads without throwing", () => {
    const html = `<script>window.__NUXT__={not: valid json}</script>`;
    expect(() => extractSPAData(html)).not.toThrow();
    // Should return empty — nothing extractable.
    expect(extractSPAData(html).length).toBe(0);
  });
});
