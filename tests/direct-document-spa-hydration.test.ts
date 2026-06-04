import { describe, expect, test } from "bun:test";
import { buildDirectDocumentResult } from "../src/orchestrator/direct-document.js";

// Fix 3 (contract 16d49b9f): when direct-document sees a Next.js / Nuxt /
// Apollo / Redux SSR shell whose visible body text is below the hydration
// floor, it MUST reject with `spa_hydration_required` and surface the
// detected markers as evidence. Without this rejection the orchestrator
// returns a 77-byte meta envelope ({title, url, site_name}) as a successful
// retrieval — observed on civitai search.
describe("direct-document SPA hydration gate", () => {
  test("rejects Next.js shell with __NEXT_DATA__ marker and thin body", () => {
    // 5KB+ shell with __NEXT_DATA__ inline marker and minimal visible text.
    // The shell HTML is fattened with hidden CSS variables / preload links to
    // clear the MIN_DIRECT_DOCUMENT_HTML_BYTES (5KB) floor while keeping the
    // post-strip body text < 2000 chars (only the title + a loading skeleton
    // survive). This is the civitai search shape.
    const preload =
      `<link rel="preload" as="script" href="/_next/static/chunks/main-${Array(6000).fill("x").join("")}.js">`;
    const html = [
      "<!doctype html><html><head>",
      "<title>Models | Civitai</title>",
      preload,
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { hydrated: false } } })}</script>`,
      "</head><body>",
      "<div id=\"__next\"><div class=\"loading\">Loading...</div></div>",
      "</body></html>",
    ].join("");
    expect(html.length).toBeGreaterThan(5_000);

    const result = buildDirectDocumentResult(
      "https://civitai.com/search/models?q=anime",
      html,
      "text/html; charset=utf-8",
      "civitai anime models search",
    );

    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("spa_hydration_required");
    expect(result.evidence?.spa_markers).toBeDefined();
    expect(result.evidence?.spa_markers?.length ?? 0).toBeGreaterThan(0);
    // At least one marker must hit __NEXT_DATA__ or _next/static.
    const markerJoined = (result.evidence?.spa_markers ?? []).join(" ");
    expect(/__NEXT_DATA__|_next\/static/i.test(markerJoined)).toBe(true);
    expect(result.evidence?.body_text_chars).toBeLessThan(2_000);
  });

  test("rejects Nuxt shell with __NUXT__ marker and thin body", () => {
    const preload =
      `<link rel="preload" href="/_nuxt/static/${Array(6000).fill("x").join("")}.js">`;
    const html = [
      "<!doctype html><html><head>",
      "<title>Some Nuxt App</title>",
      preload,
      "<script>window.__NUXT__ = { state: {} };</script>",
      "</head><body><div id=\"__nuxt\"></div></body></html>",
    ].join("");
    expect(html.length).toBeGreaterThan(5_000);

    const result = buildDirectDocumentResult(
      "https://example-nuxt-site.test/search",
      html,
      "text/html",
      "search nuxt content",
    );

    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("spa_hydration_required");
  });

  test("does NOT reject a real SSR page that happens to ship hydration data alongside content", () => {
    // A real wikipedia/stackoverflow-style page: large body text PLUS
    // hydration markers. The body-text-floor gate prevents this from
    // tripping the SPA escalation — only un-hydrated shells should escalate.
    const realContent =
      "<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(120) +
      "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(60) +
      "</p>";
    const html = [
      "<!doctype html><html><head><title>Real article — Hybrid SSR</title>",
      "<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{}}</script>",
      "</head><body><article>",
      realContent,
      "</article></body></html>",
    ].join("");

    const result = buildDirectDocumentResult(
      "https://hybrid-ssr.example/article/foo",
      html,
      "text/html",
      "article hybrid ssr",
    );

    // Should NOT be rejected via spa_hydration_required — the body has real
    // content (>= floor), so the page IS the data even if hydration markers
    // are present.
    if (result.rejected) {
      expect(result.reason).not.toBe("spa_hydration_required");
    } else {
      expect(result.text_excerpt.length).toBeGreaterThan(500);
    }
  });

  // Fix 2: a marker-less client-rendered shell (Vite/CRA/Angular/Svelte) ships
  // an empty `<div id="root">` + one bundle script with NO inline state blob
  // (__NEXT_DATA__ etc.). It must still escalate via spa_hydration_required so
  // the browser ladder does a hydration wait and captures the XHR API.
  test("rejects marker-less CSR shell (empty <div id=root>) via spa_hydration_required", () => {
    const filler = `<link rel="modulepreload" href="/assets/index-${Array(6000).fill("a").join("")}.js">`;
    const html = [
      "<!doctype html><html><head>",
      "<title>My Vite App</title>",
      filler,
      "<script type=\"module\" src=\"/assets/index-abc123.js\"></script>",
      "</head><body>",
      "<div id=\"root\"></div>",
      "</body></html>",
    ].join("");
    expect(html.length).toBeGreaterThan(5_000);

    const result = buildDirectDocumentResult(
      "https://some-vite-spa.test/dashboard",
      html,
      "text/html; charset=utf-8",
      "dashboard data",
    );

    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("spa_hydration_required");
    expect(result.evidence?.spa_markers?.length ?? 0).toBeGreaterThan(0);
  });

  // Fix 5: a parked / for-sale registrar lander clears the structural gates but
  // has no content + no API. It must fail terminally (dead_or_parked) so the
  // caller does NOT burn the per-site budget escalating through the browser.
  test("rejects a parked / for-sale domain lander via dead_or_parked", () => {
    const html = [
      "<!doctype html><html><head><title>example.tld</title></head><body>",
      "<h1>This domain is for sale</h1>",
      "<p>Buy this domain. Inquire now. " + "filler ".repeat(900) + "</p>",
      "</body></html>",
    ].join("");
    expect(html.length).toBeGreaterThan(5_000);

    const result = buildDirectDocumentResult(
      "https://parked-example.tld/",
      html,
      "text/html",
      "some product listing",
    );

    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("dead_or_parked");
  });

  // Guard: a real content page that merely contains the words "domain" must NOT
  // be mistaken for parked (PARKED_RE is anchored on lander phrases).
  test("does NOT flag a real article mentioning domains as dead_or_parked", () => {
    const body = "<article>" +
      "How to register a domain name and configure DNS records for your website. ".repeat(80) +
      "</article>";
    const html = `<!doctype html><html><head><title>Domain guide</title></head><body>${body}</body></html>`;
    const result = buildDirectDocumentResult(
      "https://realsite.example/guide",
      html,
      "text/html",
      "domain registration guide",
    );
    if (result.rejected) expect(result.reason).not.toBe("dead_or_parked");
  });

  test("does NOT reject when there are no SPA markers, even with thin body (interstitial fallthrough)", () => {
    // No __NEXT_DATA__ / _next/static / __NUXT__ markers. With a thin body
    // this should still be rejected, but via the existing
    // `interstitial_detected` body-text-floor path, NOT via the new
    // spa_hydration_required gate.
    const html =
      "<!doctype html><html><head><title>Foo</title></head><body>" +
      "<div>" + "x".repeat(6_000) + "</div>" +  // long but visible text after strip is just "xxxx..."
      "</body></html>";

    const result = buildDirectDocumentResult(
      "https://example.com/foo",
      html,
      "text/html",
      "foo bar baz",
    );

    if (result.rejected) {
      expect(result.reason).not.toBe("spa_hydration_required");
    }
  });
});
