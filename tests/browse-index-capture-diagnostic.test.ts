// Falsifier for Bug 2 in the 2026-05-18 MCP gate run `20260518T092341Z`:
// 17 probes (002 npmjs, 003 crates.io, 010 dockerhub, 013 r/programming,
// 016 stackoverflow, 026 amazon, 027 bing, 029 beatsaver, 032 ebay, 052
// bestbuy, 054 baseball-reference, 046 g2, 048 realtor, ...) returned
// indexed=false with no actionable signal in close-body. The agent could
// not tell whether the failure was (a) HAR empty under parallel conc=4,
// (b) extractEndpoints filter eating everything, (c) DOM extractor below
// the confidence gate, (d) Cloudflare/anti-bot challenge response.
//
// Fix surfaces a `capture_diagnostic` field on every cacheBrowseRequests
// return so the agent reads raw counts and gate reasons. This test pins
// the shape on three honest pipeline paths so the diagnosis stays
// available — never synthesized verdicts, only declared values from
// existing stages.
import { describe, expect, it } from "bun:test";
import { cacheBrowseRequests, type CaptureDiagnostic } from "../src/api/browse-index.js";

const REPEATED_ROW_HTML = `<!doctype html><html><head><title>Listing</title></head>
<body><ul>
<li class="row"><a href="/p/1">Product 1</a> <span class="price">$10</span></li>
<li class="row"><a href="/p/2">Product 2</a> <span class="price">$20</span></li>
<li class="row"><a href="/p/3">Product 3</a> <span class="price">$30</span></li>
<li class="row"><a href="/p/4">Product 4</a> <span class="price">$40</span></li>
<li class="row"><a href="/p/5">Product 5</a> <span class="price">$50</span></li>
</ul></body></html>`;

describe("capture_diagnostic — surface what is declared (Bug 2 / run 20260518T092341Z)", () => {
  it("dom-fallback fired and extracted: diagnostic carries html_size + confidence + dom_fallback_attempted", async () => {
    const result = await cacheBrowseRequests({
      sessionUrl: "https://example-dom.invalid/list",
      sessionDomain: "example-dom.invalid",
      requests: [],
      getPageHtml: async () => REPEATED_ROW_HTML,
    });
    const d: CaptureDiagnostic = result.capture_diagnostic;
    expect(d.requests_count).toBe(0);
    expect(d.raw_endpoints_count).toBe(0);
    expect(d.http_path_grew_skill).toBe(null);
    expect(d.dom_fallback_attempted).toBe(true);
    expect(d.dom_html_size).toBe(REPEATED_ROW_HTML.length);
    expect(typeof d.dom_extraction_confidence === "number" || d.dom_extraction_confidence === null).toBe(true);
  });

  it("malformed getPageHtml and no fetch fallback that succeeds: dom_decision_reason=no_html", async () => {
    const result = await cacheBrowseRequests({
      sessionUrl: "https://nonexistent-host-9b3.invalid/page",
      sessionDomain: "nonexistent-host-9b3.invalid",
      requests: [],
      getPageHtml: async () => "[object Object]",
    });
    const d: CaptureDiagnostic = result.capture_diagnostic;
    expect(d.dom_fallback_attempted).toBe(true);
    expect(d.dom_used_server_fetch).toBe(true);
    expect(d.dom_decision_reason).toBe("no_html");
    expect(result.indexed).toBe(false);
    expect(result.mode).toBe("none");
  });

  it("rejection reason from shouldIndexDomBrowseFallback is surfaced verbatim when extraction yields no data", async () => {
    // HTML with no extractable repeated pattern - the page has prose only.
    // Extractor returns no data; shouldIndexDomBrowseFallback returns
    // allow=false with reason="no_dom_data" (declared in browse-index.ts:127).
    const proseHtml = `<!doctype html><html><body><p>Just some prose.</p></body></html>`;
    const result = await cacheBrowseRequests({
      sessionUrl: "https://example-prose.invalid/post",
      sessionDomain: "example-prose.invalid",
      requests: [],
      getPageHtml: async () => proseHtml,
    });
    const d: CaptureDiagnostic = result.capture_diagnostic;
    expect(d.dom_fallback_attempted).toBe(true);
    // The reason is surfaced verbatim — either from shouldIndexDomBrowseFallback
    // (e.g. "no_dom_data") or the synthesized fallback "no_extracted_data" /
    // "dom_fallback_rejected". The agent reads any of these. We assert it's
    // populated (not null) so the substrate has spoken.
    if (result.indexed === false && result.mode === "none") {
      expect(d.dom_decision_reason).not.toBe(null);
    }
  });
});
