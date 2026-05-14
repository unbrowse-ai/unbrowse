// Regression: when a browse session lands on an SSR page that carries a
// JSON-LD ItemList / Product[] / Article block, /v1/browse/markdown and
// /v1/browse/text should surface that structured data at the TOP of the
// agent-visible output.
//
// Background: 2026-05-14 a "find me shoes on carousell" session used
// unbrowse_markdown to read /search/shoes. The rendered DOM contained the
// publisher's SSR listings AND a personalized "dropped_in_price" rec widget
// whose XHR results got injected as cards. The agent text-extracted both
// streams interleaved and reported a kids-shoe-skewed mix that did not
// match the canonical "Best Match" search result.
//
// Generalisable fix: the publisher's own JSON-LD is authoritative for what
// the page IS about. Prepending it gives the agent a clean reference
// before reading the rendered DOM. Works for any site emitting JSON-LD —
// Carousell, Amazon, eBay, Lazada, Allrecipes, IMDb, npm, GitHub, etc.

import { describe, expect, test } from "bun:test";
import { buildStructuredDataHeader } from "../src/extraction/index";

const SHOE_SEARCH_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Search results for "shoes"</title>
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": "Shoes",
      "numberOfItems": 5,
      "itemListElement": [
        { "@type": "ListItem", "position": 1, "item": {
          "@type": "Product", "name": "Nike Air Max 90",
          "offers": { "@type": "Offer", "price": "150.00", "priceCurrency": "SGD", "availability": "InStock" }
        }},
        { "@type": "ListItem", "position": 2, "item": {
          "@type": "Product", "name": "Adidas Samba OG",
          "offers": { "@type": "Offer", "price": "120.00", "priceCurrency": "SGD" }
        }},
        { "@type": "ListItem", "position": 3, "item": {
          "@type": "Product", "name": "New Balance 990v6",
          "offers": { "@type": "Offer", "price": "299.00", "priceCurrency": "SGD" }
        }},
        { "@type": "ListItem", "position": 4, "item": {
          "@type": "Product", "name": "Vans Old Skool",
          "offers": { "@type": "Offer", "price": "89.00", "priceCurrency": "SGD" }
        }},
        { "@type": "ListItem", "position": 5, "item": {
          "@type": "Product", "name": "Converse Chuck 70",
          "offers": { "@type": "Offer", "price": "110.00", "priceCurrency": "SGD" }
        }}
      ]
    }
  </script>
</head>
<body>
  <div class="page">
    <!-- Imagine here the SSR listings + an injected rec widget with kids shoes -->
    <div class="search-results">canonical listings here</div>
    <div class="rec-widget">dropped_in_price personalized cards here</div>
  </div>
</body>
</html>`;

const SINGLE_PRODUCT_HTML = `<!DOCTYPE html>
<html><head>
<script type="application/ld+json">
{ "@context": "https://schema.org", "@type": "Product",
  "name": "Sony WH-1000XM5", "brand": "Sony",
  "offers": { "@type": "Offer", "price": "549.00", "priceCurrency": "SGD" } }
</script>
</head><body><h1>Sony WH-1000XM5</h1></body></html>`;

const ARTICLE_HTML = `<!DOCTYPE html>
<html><head>
<script type="application/ld+json">
{ "@context": "https://schema.org", "@type": "Article",
  "headline": "Why agentic browsing matters",
  "author": { "@type": "Person", "name": "Lewis Tham" },
  "datePublished": "2026-05-14" }
</script>
</head><body><article>article body</article></body></html>`;

const NO_LD_HTML = `<!DOCTYPE html><html><body><p>plain page, no structured data</p></body></html>`;

const MALFORMED_LD_HTML = `<!DOCTYPE html><html><head>
<script type="application/ld+json">{ this isnt valid json }</script>
</head><body><p>page with broken ld json</p></body></html>`;

describe("buildStructuredDataHeader", () => {
  test("formats a JSON-LD ItemList of Products into a clean markdown table", () => {
    const header = buildStructuredDataHeader(SHOE_SEARCH_HTML);
    expect(header).not.toBeNull();
    expect(header!).toContain("Structured data (JSON-LD");
    // ItemList items, in declared order
    expect(header!).toContain("Nike Air Max 90");
    expect(header!).toContain("Adidas Samba OG");
    expect(header!).toContain("New Balance 990v6");
    // Prices preserved with currency
    expect(header!).toContain("150.00");
    expect(header!).toContain("SGD");
    // The ItemList type leaks through somewhere
    expect(header!).toContain("ItemList");
  });
  test("formats a single Product into a clean detail block", () => {
    const header = buildStructuredDataHeader(SINGLE_PRODUCT_HTML);
    expect(header).not.toBeNull();
    expect(header!).toContain("Sony WH-1000XM5");
    expect(header!).toContain("549.00");
    expect(header!).toContain("SGD");
  });

  test("formats an Article into a clean detail block", () => {
    const header = buildStructuredDataHeader(ARTICLE_HTML);
    expect(header).not.toBeNull();
    expect(header!).toContain("Why agentic browsing matters");
    expect(header!).toContain("Lewis Tham");
  });

  test("returns null when the page has no JSON-LD", () => {
    expect(buildStructuredDataHeader(NO_LD_HTML)).toBeNull();
  });

  test("returns null (does not throw) when JSON-LD is malformed", () => {
    expect(buildStructuredDataHeader(MALFORMED_LD_HTML)).toBeNull();
  });

  test("returns null for HTML with no structurally-interesting JSON-LD", () => {
    // WebSite / SearchAction / BreadcrumbList alone is not useful as a header
    const html = `<html><head><script type="application/ld+json">
      { "@context": "https://schema.org", "@type": "WebSite",
        "url": "https://example.com", "potentialAction": {
          "@type": "SearchAction", "target": "https://example.com/search?q={q}" } }
      </script></head><body></body></html>`;
    expect(buildStructuredDataHeader(html)).toBeNull();
  });
});
