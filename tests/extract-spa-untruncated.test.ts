import { describe, expect, test } from "bun:test";
import { extractSPAData } from "../src/extraction/index";

// B4 fix — SSR payload silent truncation past MAX_HTML_SIZE.
//
// Two surfaces tested:
//   1. JSON-LD (<script type="application/ld+json">) blocks past byte 300_000
//      were lost because cheerio/cleanDOM ran on truncated HTML. extractSPAData
//      now walks the FULL HTML for ld+json before any truncation.
//   2. <script id="__NEXT_DATA__"> previously used a non-greedy regex that
//      could terminate at a literal "</script>" substring inside escaped page
//      content. Now uses indexOf forward search.

function pad(bytes: number): string {
  // Realistic chrome: lots of class-bloated divs that fill the head/body
  return `<div class="${"x".repeat(50)}" data-testid="${"y".repeat(50)}"></div>`.repeat(Math.ceil(bytes / 130));
}

describe("extractSPAData B4 — pre-truncation extraction", () => {
  test("finds JSON-LD block placed past byte 300_000 (was silently dropped)", () => {
    const lateLd = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "DEEP_BURIED_HEADLINE_TOKEN",
      author: { "@type": "Person", name: "Test Author" },
    });
    const html = `<!doctype html><html><body>${pad(350_000)}<script type="application/ld+json">${lateLd}</script></body></html>`;
    expect(html.length).toBeGreaterThan(300_000);
    const results = extractSPAData(html);
    const found = results.find((r) =>
      JSON.stringify(r.data).includes("DEEP_BURIED_HEADLINE_TOKEN"),
    );
    expect(found).toBeDefined();
  });

  test("finds JSON-LD with @graph array shape", () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Article", headline: "GRAPH_NODE_ONE" },
        { "@type": "Person", name: "GRAPH_NODE_TWO" },
      ],
    });
    const html = `<html><body><script type="application/ld+json">${ld}</script></body></html>`;
    const results = extractSPAData(html);
    const blob = JSON.stringify(results);
    expect(blob).toContain("GRAPH_NODE_ONE");
    expect(blob).toContain("GRAPH_NODE_TWO");
  });

  test("__NEXT_DATA__ extraction tolerates large pageProps past 300_000 bytes", () => {
    const pageProps = {
      title: "DEEP_NEXTJS_PAGE_PROP",
      bigPayload: "z".repeat(400_000),
    };
    const nextData = JSON.stringify({ props: { pageProps } });
    const html = `<!doctype html><html><body><div>chrome</div><script id="__NEXT_DATA__" type="application/json">${nextData}</script></body></html>`;
    const results = extractSPAData(html);
    const blob = JSON.stringify(results);
    expect(blob).toContain("DEEP_NEXTJS_PAGE_PROP");
  });

  test("multiple JSON-LD blocks all surfaced", () => {
    const a = JSON.stringify({ "@type": "Recipe", name: "RECIPE_ONE" });
    const b = JSON.stringify({ "@type": "Product", name: "PRODUCT_TWO" });
    const html = `<html><body><script type="application/ld+json">${a}</script><script type="application/ld+json">${b}</script></body></html>`;
    const results = extractSPAData(html);
    const blob = JSON.stringify(results);
    expect(blob).toContain("RECIPE_ONE");
    expect(blob).toContain("PRODUCT_TWO");
  });
});
