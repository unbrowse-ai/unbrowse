// Regression guard for .bench-gate/20260521T010031Z probe 031 priceline.
//
// PROBLEM (live):
//   intent = "search hotels in Tokyo" (LIST_INTENT)
//   url    = https://www.priceline.com/relax/at/tokyo
//   extracted: spa-initial-state shape carrying the page's schema.org
//     JSON-LD organization card:
//       {"@context":"https://schema.org",
//        "@type":["Organization","TravelAgency"],
//        "name":"Priceline","telephone":"...","foundingDate":"...",
//        "hasOfferCatalog":{...corporate-metadata...}}
//   The Organization / TravelAgency block describes the SITE ITSELF, not
//   the hotel listings the user asked for. Category-error: same JSON
//   shape, wrong semantic level. The extractor surfaced this as the
//   "winning" structure because it was the only SPA-state payload on the
//   page (priceline's actual listing data loads client-side).
//
// FIX (src/extraction/index.ts:looksLikeSiteMetaJsonLd):
//   Generic structural primitive — when `@type` is keyed ONLY to site-
//   metadata types (Organization | Corporation | TravelAgency |
//   OnlineStore | WebSite | WebPage), AND intent matches LIST_INTENT,
//   apply -200 demotion (same magnitude as scoreEmptyContainerDemotion).
//   No per-host registry. Falsifier carve-outs preserve single-entity
//   types on DETAIL_INTENT, ItemList for any intent, and site-meta types
//   for DETAIL_INTENT (e.g. "get priceline contact info").
//
// Real-runtime: live extractFromDOM, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOM, looksLikeSiteMetaJsonLd } from "../src/extraction/index.js";

describe("looksLikeSiteMetaJsonLd primitive", () => {
  test("Organization+TravelAgency array → site-meta", () => {
    expect(
      looksLikeSiteMetaJsonLd({
        "@context": "https://schema.org",
        "@type": ["Organization", "TravelAgency"],
        name: "Priceline",
      }),
    ).toBe(true);
  });

  test("bare Organization string → site-meta", () => {
    expect(
      looksLikeSiteMetaJsonLd({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Acme",
      }),
    ).toBe(true);
  });

  test("Hotel → NOT site-meta (single-entity card)", () => {
    expect(
      looksLikeSiteMetaJsonLd({
        "@context": "https://schema.org",
        "@type": "Hotel",
        name: "Park Hyatt Tokyo",
      }),
    ).toBe(false);
  });

  test("ItemList → NOT site-meta (real listing)", () => {
    expect(
      looksLikeSiteMetaJsonLd({
        "@context": "https://schema.org",
        "@type": "ItemList",
        itemListElement: [{ "@type": "Hotel", name: "A" }],
      }),
    ).toBe(false);
  });

  test("array containing one site-meta + one entity type → NOT site-meta", () => {
    // Mixed @type with a real entity wins — `Hotel,Organization` is a
    // hotel-owned-by-an-org card, not the site card.
    expect(
      looksLikeSiteMetaJsonLd({
        "@type": ["Organization", "Hotel"],
        name: "Some Hotel",
      }),
    ).toBe(false);
  });
});

describe("extractFromDOM: priceline reproducer", () => {
  test("LIST_INTENT — Organization+TravelAgency JSON-LD is demoted, not returned as the listing", () => {
    // Mimic priceline.com homepage shape: one chunky JSON-LD card
    // embedded as a Next.js SPA-state payload, no real ItemList present.
    const orgCard = {
      "@context": "https://schema.org",
      "@type": ["Organization", "TravelAgency"],
      name: "Priceline",
      telephone: "+1-877-477-5807",
      foundingDate: "1997",
      url: "https://www.priceline.com",
      description: "Travel deals on hotels, flights, vacation packages, cruises and rental cars.",
      hasOfferCatalog: {
        "@type": "OfferCatalog",
        name: "Travel offers",
      },
    };
    const html = `<!doctype html><html><head>
      <title>Hotels in Tokyo | Priceline</title>
      <meta property="og:title" content="Hotels in Tokyo">
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: orgCard },
      })}</script>
    </head><body><main><h1>Hotels in Tokyo</h1></main></body></html>`;

    const result = extractFromDOM(html, "search hotels in Tokyo");
    // The Organization card MUST NOT be the picked extraction. The
    // extractor may legitimately fall through to the metadata fallback
    // (title/og:title) or return null — both are correct for a page
    // whose listings live in post-mount XHR. What it must NOT do is
    // hand the agent the corporate identity card as the "hotels in
    // Tokyo" answer.
    const serialized = JSON.stringify(result.data ?? {});
    expect(serialized).not.toContain("TravelAgency");
    expect(serialized).not.toContain("hasOfferCatalog");
    expect(serialized).not.toContain("foundingDate");
  });

  test("falsifier: DETAIL_INTENT for a Hotel single-entity card — NOT demoted", () => {
    const hotelCard = {
      "@context": "https://schema.org",
      "@type": "Hotel",
      name: "Park Hyatt Tokyo",
      address: { "@type": "PostalAddress", addressLocality: "Tokyo" },
      starRating: { "@type": "Rating", ratingValue: 5 },
      description: "Luxury hotel in Shinjuku featured in Lost in Translation.",
    };
    const html = `<!doctype html><html><head>
      <title>Park Hyatt Tokyo</title>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: hotelCard },
      })}</script>
    </head><body><h1>Park Hyatt Tokyo</h1></body></html>`;

    const result = extractFromDOM(html, "get park hyatt tokyo details");
    // Hotel single-entity card on a DETAIL_INTENT is exactly what was
    // asked for — the name must survive into the output.
    const serialized = JSON.stringify(result.data ?? {});
    expect(serialized).toContain("Park Hyatt Tokyo");
  });

  test("falsifier: ItemList of hotels on LIST_INTENT — NOT demoted", () => {
    const listCard = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      itemListElement: [
        { "@type": "Hotel", name: "Park Hyatt Tokyo", priceRange: "$$$$" },
        { "@type": "Hotel", name: "Aman Tokyo", priceRange: "$$$$" },
        { "@type": "Hotel", name: "The Tokyo Edition", priceRange: "$$$" },
      ],
    };
    const html = `<!doctype html><html><head>
      <title>Tokyo Hotels</title>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: listCard },
      })}</script>
    </head><body><h1>Tokyo Hotels</h1></body></html>`;

    const result = extractFromDOM(html, "search hotels in Tokyo");
    // The ItemList IS the listing; at least one hotel name must survive.
    const serialized = JSON.stringify(result.data ?? {});
    expect(serialized).toMatch(/Park Hyatt Tokyo|Aman Tokyo|The Tokyo Edition/);
  });

  test("falsifier: Organization JSON-LD on DETAIL_INTENT — NOT demoted", () => {
    // The agent EXPLICITLY asked for the corporate metadata; the
    // Organization card is the right answer for this intent.
    const orgCard = {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Priceline",
      telephone: "+1-877-477-5807",
      foundingDate: "1997",
      url: "https://www.priceline.com",
    };
    const html = `<!doctype html><html><head>
      <title>About Priceline</title>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: orgCard },
      })}</script>
    </head><body><h1>About Priceline</h1></body></html>`;

    const result = extractFromDOM(html, "get priceline contact info");
    // Phone number / founding date must survive — that's the data
    // the agent asked for.
    const serialized = JSON.stringify(result.data ?? {});
    expect(serialized).toMatch(/Priceline|877-477-5807|1997/);
  });
});
