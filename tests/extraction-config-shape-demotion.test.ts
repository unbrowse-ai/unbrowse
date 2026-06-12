// W3: when the captured HTML contains BOTH a real-data structure (e.g.
// repeated product cards) AND a Next.js React-Server-Components (RSC)
// bootstrap stub (`["$","link","0",{rel:"stylesheet",..}]` chunks),
// extractFromDOM must NOT rank the RSC stub above the real data. Same
// for i18n bundles (`globalTranslations.global.a11y.*`) and stylesheet-
// chunk objects.
//
// Live regression source: .bench-gate/20260519T203955Z verdict.json on
// probe 066 hostile vinted_jeans. execute.response.raw was the literal
// Next.js RSC payload (links + scripts only), no real listings. The
// page-artifact DOM recipe learned this shape because the extractor
// scored RSC chunks higher than the listing nodes during indexing.
//
// Fix: a `looksLikeConfigShape` guard in src/extraction/index.ts that
// detects these junk shapes and applies a heavy demotion (-200) so real
// data wins. Coherent with the platform-tells-the-truth principle:
// surface what's declared, never invent.
//
// Real-runtime: live extractFromDOM, no mocks, no stubs.

import { describe, expect, test } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

describe("W3: config-shape demotion (RSC bootstrap, i18n, chunk objects)", () => {
  test("vinted-style RSC bootstrap chunks do NOT beat repeated product cards", () => {
    // The captured page from a Next-RSC site has BOTH:
    //   (a) an RSC stub array embedded in a <script> as Next data
    //   (b) the real product listings as repeated DOM cards in <body>
    // Pre-fix: the RSC chunk array (10 entries, "looks like a list")
    // scored higher than the cards. Post-fix: the cards win.
    const html = `<!doctype html><html><body>
      <main>
        <article class="card item">
          <a class="card-link" href="/items/1">Vintage Levi 501, size 32</a>
          <span class="price">$45</span>
          <span class="brand">Levi's</span>
        </article>
        <article class="card item">
          <a class="card-link" href="/items/2">Wrangler Bootcut jeans</a>
          <span class="price">$32</span>
          <span class="brand">Wrangler</span>
        </article>
        <article class="card item">
          <a class="card-link" href="/items/3">Diesel slim-fit denim</a>
          <span class="price">$60</span>
          <span class="brand">Diesel</span>
        </article>
      </main>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: {} },
        page: "/catalog",
        children: [
          ["$", "link", "0", { rel: "stylesheet", href: "https://assets.example.com/_next/static/chunks/0gtiytfni_zd8.css", precedence: "next", crossOrigin: "$undefined", nonce: "$undefined" }],
          ["$", "script", "script-0", { src: "https://assets.example.com/_next/static/chunks/0~9haenlu.s.8.js", async: true, nonce: "$undefined" }],
          ["$", "script", "script-1", { src: "https://assets.example.com/_next/static/chunks/10hgwd70zt4~p.js", async: true, nonce: "$undefined" }],
          ["$", "script", "script-2", { src: "https://assets.example.com/_next/static/chunks/0aicljucbndax.js", async: true, nonce: "$undefined" }],
          ["$", "script", "script-3", { src: "https://assets.example.com/_next/static/chunks/0lqsef9pfbelm.js", async: true, nonce: "$undefined" }],
          ["$", "script", "script-4", { src: "https://assets.example.com/_next/static/chunks/0n92ceyn.t-_0.js", async: true, nonce: "$undefined" }],
          ["$", "script", "script-5", { src: "https://assets.example.com/_next/static/chunks/0vw1zuobd3bgt.js", async: true, nonce: "$undefined" }],
          ["$", "script", "script-6", { src: "https://assets.example.com/_next/static/chunks/0jrziijx62wey.js", async: true, nonce: "$undefined" }],
        ],
      })}</script>
    </body></html>`;

    const result = extractFromDOM(html, "list jeans for sale");

    // The data field must be the product cards array, NOT the RSC chunks.
    // the platform may legitimately return either repeated-elements or
    // a structured payload, but it MUST NOT be the chunk array.
    expect(result.data).not.toBeNull();
    const dataStr = JSON.stringify(result.data);
    // Negative assertion: RSC config-shape signatures must NOT appear in
    // the top-pick data.
    expect(dataStr).not.toContain("precedence");
    expect(dataStr).not.toContain("_next/static/chunks");
    expect(dataStr).not.toContain("$undefined");
    // Positive assertion: at least one real product card field survives.
    expect(dataStr.toLowerCase()).toMatch(/levi|wrangler|diesel|jeans/);
  });

  test("i18n bundle (translations.* + a11y.*) does NOT beat real list content", () => {
    // Ticketmaster-style: capture pulled a globalTranslations object as
    // a "list" of strings. Real event cards are also on the page.
    const i18nBundle: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      i18nBundle[`globalTranslations.global.a11y.label_${i}`] = `Translation string ${i}`;
    }
    const html = `<!doctype html><html><body>
      <main>
        <div class="event-card">
          <h3 class="event-title">Coldplay: Music of the Spheres Tour</h3>
          <span class="venue">SoFi Stadium, Los Angeles</span>
          <span class="event-date">2026-06-15</span>
        </div>
        <div class="event-card">
          <h3 class="event-title">Taylor Swift: Eras Tour</h3>
          <span class="venue">MetLife Stadium</span>
          <span class="event-date">2026-07-20</span>
        </div>
        <div class="event-card">
          <h3 class="event-title">Beyonce: Renaissance World Tour</h3>
          <span class="venue">Mercedes-Benz Stadium</span>
          <span class="event-date">2026-08-10</span>
        </div>
      </main>
      <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { translations: i18nBundle, theme: { gradients: { mrBlueSky: "linear-gradient(...)" } } } },
      })}</script>
    </body></html>`;

    const result = extractFromDOM(html, "concert events tickets");

    const dataStr = JSON.stringify(result.data);
    // Negative: translation keys must not dominate.
    expect(dataStr).not.toContain("globalTranslations");
    expect(dataStr).not.toContain("a11y.label");
    expect(dataStr).not.toContain("mrBlueSky");
    // Positive: at least one real event field.
    expect(dataStr).toMatch(/Coldplay|Taylor Swift|Beyonce/);
  });
});
