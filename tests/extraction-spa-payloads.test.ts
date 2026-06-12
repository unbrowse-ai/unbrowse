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

  it("unwraps React Query dehydratedState into per-query data payloads", () => {
    // decrypt.co-class: pageProps is dominated by framework metadata
    // (i18n, variables, activeTerm), and the real content lives in
    // dehydratedState.queries[*].state.data. Prior to unwrap the intent
    // matcher saw only the metadata keys and rejected the SPA source
    // in favor of noisy DOM repeated-elements.
    const payload = JSON.stringify({
      props: {
        pageProps: {
          _nextI18Next: { initialLocale: "en" },
          variables: { slug: "news" },
          activeTerm: { name: "news" },
          dehydratedState: {
            mutations: [],
            queries: [
              {
                queryKey: ["articles", "news"],
                queryHash: "x",
                state: {
                  data: {
                    articles: [
                      { id: 1, title: "Bitcoin hits new high", author: "Alice" },
                      { id: 2, title: "Ethereum upgrade launches", author: "Bob" },
                    ],
                    total: 2,
                  },
                  status: "success",
                },
              },
              {
                queryKey: ["sidebar"],
                queryHash: "y",
                state: {
                  data: { trending: ["btc", "eth"], featured: ["sol"] },
                  status: "success",
                },
              },
            ],
          },
        },
      },
    });
    const html = `<script id="__NEXT_DATA__" type="application/json">${payload}</script>`;
    const spa = extractSPAData(html);
    // Expect the per-query data structures to be surfaced as distinct SPA
    // structures (first two are the unwrapped queries, the third is the
    // raw pageProps with dehydratedState stripped).
    expect(spa.length).toBe(3);
    const articlesData = spa.find((s) => {
      const d = s.data as Record<string, unknown>;
      return Array.isArray(d.articles);
    });
    expect(articlesData).toBeDefined();
    const articles = (articlesData!.data as any).articles;
    expect(articles.length).toBe(2);
    expect(articles[0].title).toBe("Bitcoin hits new high");
  });

  it("flattens React Infinite Query pagination wrapper inside dehydratedState", () => {
    // decrypt.co pattern: dehydratedState.queries[?].state.data is
    // {pages, pageParams} — React Infinite Query's paginated cache. The
    // real articles live inside pages[*].data (or items/results/etc.).
    // Without flattening, the SPA structure looks like {pages, pageParams}
    // which has no intent-matching content and loses to DOM scraping.
    const payload = JSON.stringify({
      props: {
        pageProps: {
          dehydratedState: {
            queries: [
              {
                queryKey: ["ArticlePreviews"],
                state: {
                  data: {
                    pages: [
                      {
                        data: [
                          { id: 1, title: "Bitcoin news one", slug: "btc-1" },
                          { id: 2, title: "Ethereum news two", slug: "eth-2" },
                        ],
                      },
                      {
                        data: [
                          { id: 3, title: "Solana news three", slug: "sol-3" },
                        ],
                      },
                    ],
                    pageParams: [null, 2],
                  },
                },
              },
            ],
          },
        },
      },
    });
    const html = `<script id="__NEXT_DATA__" type="application/json">${payload}</script>`;
    const spa = extractSPAData(html);
    // Should surface a flat array of 3 articles from the paginated pages.
    const articles = spa.find((s) => Array.isArray(s.data) && (s.data as any[]).length === 3);
    expect(articles).toBeDefined();
    const arr = articles!.data as any[];
    expect(arr[0].title).toBe("Bitcoin news one");
    expect(arr[2].slug).toBe("sol-3");
  });

  it("extracts data from Next.js 13+ App Router streaming self.__next_f.push calls", () => {
    // Real-world shape: each push carries [1, "<id>:<json>\n"] where the
    // inner string is JSON-encoded — quotes are escaped with \" in the
    // browser's raw HTML. JSON.stringify-ing the payload twice gives us
    // the correct double-escaped literal that matches the wire format.
    const bigPayload = JSON.stringify({
      product: {
        id: "widget-42",
        name: "A Widget",
        price: 129.99,
        attributes: { color: "red", weight: 2.5 },
        reviews: [
          { author: "Alice", rating: 5 },
          { author: "Bob", rating: 4 },
        ],
      },
    });
    // JSON.stringify the inner string a second time — that gives us the
    // `\"product\":` escaped form that Next.js actually emits, wrapped in
    // outer `"`. We then build the final HTML via string concatenation
    // rather than a template literal because template literals eat the
    // backslash-escape at compile time and the runtime would see bare
    // `"` inside the `[1, "..."]` list, which is not valid JS.
    const push1 = JSON.stringify("1:" + bigPayload + "\n");
    const push0 = JSON.stringify("0:x\n");
    const html =
      "<script>self.__next_f=self.__next_f||[];self.__next_f.push([1," + push0 + "])</script>" +
      "<script>self.__next_f.push([1," + push1 + "])</script>";
    const spa = extractSPAData(html);
    const appRouterHit = spa.find((s) => s.type === "spa-initial-state");
    expect(appRouterHit).toBeDefined();
    const data = appRouterHit!.data as Record<string, unknown>;
    expect((data.product as any).name).toBe("A Widget");
    expect((data.product as any).reviews.length).toBe(2);
  });
});
