import { describe, expect, it } from "bun:test";
import { buildDirectDocumentResult } from "../src/orchestrator/direct-document.js";

/**
 * Server-rendered pages that ship their records inside the hydration blob.
 *
 * Measured against live pages (2026-08-04), three defects made unbrowse discard
 * or misreport data it had already downloaded:
 *
 *  1. GAP BAND — the embedded-collection rescue required visible chrome < 500
 *     chars while the SPA gate rejected below 2000, so a page landing between
 *     the two (zillow's listing page: 719 chars) had its collection recovered
 *     and then thrown away, and was sent to the browser ladder holding the
 *     answer.
 *  2. SHALLOW WALK — the record walk stopped at depth 6, but modern SSR state
 *     buries content at depth 9-11 (`dehydratedState.queries[n].state.data…`),
 *     so only shallow plumbing was reachable and a telemetry blob won by
 *     default.
 *  3. WHOLE-BLOCK PAYLOAD — the located collection's path was computed and then
 *     discarded, and the ENTIRE hydration block was handed to the budget
 *     slicer; on target.com the agent received ad-placement config cut
 *     mid-token, reported as success.
 */
describe("direct-document recovers records from a hydration shell", () => {
  // ~700 chars of visible chrome: above the 500 embedded-rescue floor and below
  // the 2000 SPA-hydration floor — precisely the band that used to be lost.
  const navText =
    "Home Browse Categories Deals Today Stores Gift Cards Registry Weekly Ad " +
    "Account Orders Lists Help Center Contact Us Careers Investors Press Room " +
    "Privacy Policy Terms of Use Accessibility Statement Interest Based Ads " +
    "California Transparency Supply Chain Recalls Product Safety Store Locator " +
    "Same Day Delivery Order Pickup Drive Up Returns Exchanges Shipping Info " +
    "Track Order Customer Service Feedback Site Map Affiliates Partnerships " +
    "Sustainability Community Giving Diversity Suppliers Real Estate Brand Hub";

  const chrome =
    `<!doctype html><html><head><title>Grocery Deals</title></head><body>` +
    `<div id="__next"><nav>${navText}</nav></div>`;

  const pad = `<!-- ${"x".repeat(5_000)} -->`;

  /** Opaque machine plumbing: 30 records, zero human-facing text. */
  const telemetry = Array.from({ length: 30 }, (_, i) => ({
    tid: `WEB-44${i}`,
    pl: `plc_${i}a3f`,
    et: "add_to_cart",
  }));

  /** Real content, buried at the depth a React-Query hydration blob uses. */
  const items = [
    { name: "Organic Whole Milk", canonical_url: "/p/organic-whole-milk/-/A-1", blurb: "One gallon, grade A" },
    { name: "Sourdough Sandwich Bread", canonical_url: "/p/sourdough-bread/-/A-2", blurb: "Baked in store daily" },
    { name: "Free Range Large Eggs", canonical_url: "/p/free-range-eggs/-/A-3", blurb: "One dozen, cage free" },
    { name: "Cold Brew Coffee Concentrate", canonical_url: "/p/cold-brew/-/A-4", blurb: "Smooth and low acid" },
  ];

  const nextData = {
    props: {
      sapphireInstance: { initialExperimentTrackingDetails: { tr: telemetry } },
      pageProps: {
        dehydratedState: {
          queries: [
            { state: { data: { slots: { 100: { content: { taxonomy_nodes: items } } } } } },
          ],
        },
      },
    },
  };

  const html =
    chrome +
    pad +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>` +
    `</body></html>`;

  it("accepts a hydration shell whose chrome sits between the two floors", () => {
    const r = buildDirectDocumentResult("https://shop.example/c/grocery", html, "text/html", "list grocery items");
    // Pre-fix this rejected with `spa_hydration_required` despite the records
    // being present in the bytes we already had.
    expect(r.rejected).toBe(false);
  });

  it("returns the buried content collection, not the bigger telemetry blob", () => {
    const r = buildDirectDocumentResult("https://shop.example/c/grocery", html, "text/html", "list grocery items");
    expect(r.rejected).toBe(false);
    if (r.rejected) return;
    expect(r.markdown).toContain("Organic Whole Milk");
    expect(r.markdown).toContain("Cold Brew Coffee Concentrate");
    // The telemetry array is 30 records to the content list's 4, so raw count
    // alone chose it. It must not appear in what the agent reads.
    expect(r.markdown).not.toContain("WEB-440");
    expect(r.markdown).not.toContain("plc_0a3f");
  });

  it("hands back the located records, not the whole hydration block", () => {
    const r = buildDirectDocumentResult("https://shop.example/c/grocery", html, "text/html", "list grocery items");
    expect(r.rejected).toBe(false);
    if (r.rejected) return;
    // The payload is the resolved array, so it must be far smaller than the
    // block it came out of, and must not carry the block's unrelated branches.
    expect(r.markdown.length).toBeLessThan(JSON.stringify(nextData).length);
    expect(r.markdown).not.toContain("sapphireInstance");
    expect(r.extraction.notes.some((n) => n.startsWith("EMBEDDED_COLLECTION:"))).toBe(true);
  });

  it("prefers a small content list over a far larger telemetry blob", () => {
    // Density only dampens weight, so raw scale can still win: 1200 tracking
    // rows outweigh 4 product rows on records alone. Content must still win.
    const hugeTelemetry = Array.from({ length: 1_200 }, (_, i) => ({
      tid: `WEB-${i}`,
      pl: `plc_${i}`,
      et: "impression",
    }));
    const lopsided = {
      props: {
        sapphireInstance: { initialExperimentTrackingDetails: { tr: hugeTelemetry } },
        pageProps: {
          dehydratedState: {
            queries: [
              { state: { data: { slots: { 100: { content: { taxonomy_nodes: items } } } } } },
            ],
          },
        },
      },
    };
    const lopsidedHtml =
      chrome +
      pad +
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(lopsided)}</script>` +
      `</body></html>`;
    const r = buildDirectDocumentResult(
      "https://shop.example/c/grocery",
      lopsidedHtml,
      "text/html",
      "list grocery items",
    );
    expect(r.rejected).toBe(false);
    if (r.rejected) return;
    expect(r.markdown).toContain("Organic Whole Milk");
    expect(r.markdown).not.toContain("impression");
  });

  it("does not report success when the only collection is machine plumbing", () => {
    const telemetryOnly = {
      props: { sapphireInstance: { initialExperimentTrackingDetails: { tr: telemetry } } },
    };
    const plumbingHtml =
      chrome +
      pad +
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(telemetryOnly)}</script>` +
      `</body></html>`;
    const r = buildDirectDocumentResult(
      "https://shop.example/c/grocery",
      plumbingHtml,
      "text/html",
      "list grocery items",
    );
    // Honest outcome: escalate for a render rather than answer a product query
    // with ad-placement config. The failure mode being locked out is a
    // `task_ok:true` carrying telemetry.
    if (!r.rejected) expect(r.task_ok).toBe(false);
    else expect(r.reason).toBe("spa_hydration_required");
  });
});
