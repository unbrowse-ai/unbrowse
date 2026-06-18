// Regression guard: a single ITEM JSON-LD must not satisfy a LIST intent.
//
// PROBLEM (live, Carousell /food/q/):
//   intent = "find good food listings with titles and prices" (LIST_INTENT)
//   url    = https://www.carousell.sg/food/q/
//   The served HTML (even via libcurl-impersonate, 1.4MB) carries ONLY a
//   lazy page-level schema.org `@type:Product` + AggregateOffer — the
//   10,000+ listings render client-side and are absent from the HTML. The
//   extractor surfaced the single Product as the "winning" structure, so a
//   "find food" query returned one frozen-risoles product instead of a list.
//
// FIX (src/extraction/index.ts:scoreSingleItemListMismatch + pre-filter):
//   Cardinality invariant (Ezekiel 47:10) — a net wants many fish. On a
//   LIST_INTENT, demote/filter any single-item structure (element_count<=1,
//   valueLooksLikeSingleItem) so it cannot win by default; the caller then
//   escalates instead of returning one fish for a net. The sibling of the
//   existing scoreSiteMetaJsonLdDemotion (which only caught site-meta types).
//   Carve-outs: ItemList/collections, repeated-elements, and DETAIL_INTENT.
//
// Real-runtime: live extractFromDOM, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

const productCard = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Risoles Frozen",
  description: "Frozen Risoles, anyone keen to try? 1 pack $8",
  image: ["https://media.karousell.com/a.jpg", "https://media.karousell.com/b.jpg"],
  offers: { "@type": "AggregateOffer", lowPrice: "8", priceCurrency: "SGD" },
};

describe("extractFromDOM: single-item JSON-LD vs LIST_INTENT (Carousell reproducer)", () => {
  test("LIST_INTENT — single Product JSON-LD is demoted, not returned as the listing", () => {
    const html = `<!doctype html><html><head>
      <title>Food For Sale | Buy 10,000+ Food online | Carousell Singapore</title>
      <script type="application/ld+json">${JSON.stringify(productCard)}</script>
    </head><body><main><h1>Food For Sale</h1></main></body></html>`;

    const result = extractFromDOM(html, "find good food listings with titles and prices");
    // The single Product card MUST NOT be the picked extraction. Falling
    // through to the metadata fallback or null is correct for a page whose
    // listings live in post-mount XHR — what it must NOT do is hand back the
    // one frozen-risoles product as the "find food" answer.
    const serialized = JSON.stringify(result.data ?? {});
    expect(serialized).not.toContain("Risoles Frozen");
    expect(serialized).not.toContain("AggregateOffer");
  });

  test("falsifier: single Product on a DETAIL_INTENT — NOT demoted", () => {
    const html = `<!doctype html><html><head>
      <title>Risoles Frozen</title>
      <script type="application/ld+json">${JSON.stringify(productCard)}</script>
    </head><body><h1>Risoles Frozen</h1></body></html>`;

    // "get this product / its price" is a single-entity intent — the Product
    // card is exactly what was asked for and must survive.
    const result = extractFromDOM(html, "get the price of this product");
    const serialized = JSON.stringify(result.data ?? {});
    expect(serialized).toContain("Risoles Frozen");
  });

  test("falsifier: ItemList of products on LIST_INTENT — NOT demoted", () => {
    const listCard = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [
        { "@type": "Product", name: "Risoles Frozen", offers: { price: "8" } },
        { "@type": "Product", name: "Kueh Lapis", offers: { price: "12" } },
        { "@type": "Product", name: "Pineapple Tarts", offers: { price: "15" } },
      ],
    };
    const html = `<!doctype html><html><head>
      <title>Food For Sale</title>
      <script type="application/ld+json">${JSON.stringify(listCard)}</script>
    </head><body><h1>Food For Sale</h1></body></html>`;

    const result = extractFromDOM(html, "find good food listings with titles and prices");
    // The ItemList IS the listing — at least one product name must survive.
    const serialized = JSON.stringify(result.data ?? {});
    expect(serialized).toMatch(/Risoles Frozen|Kueh Lapis|Pineapple Tarts/);
  });
});
