import { describe, expect, it } from "bun:test";
import { buildDirectDocumentResult } from "../src/orchestrator/direct-document.js";

/**
 * quotes.toscrape.com/js/ ships its collection as `var data = [{…}]` inside a
 * plain script. Visible chrome after script strip is ~96 chars — below the
 * body-text floor — so pre-fix the document path rejected as interstitial
 * and lost to plain curl (which still has the bytes). The rescue is structural:
 * embeddedJsonBlocks + findRecordCollection, same engine as capture ranking.
 */
describe("direct-document recovers embedded script collections", () => {
  const chrome =
    `<!doctype html><html><head><title>Quotes to Scrape</title></head><body>` +
    `<div class="container"><h1><a href="/">Quotes to Scrape</a></h1>` +
    `<a href="/login">Login</a></div>`;

  // Pad so raw HTML clears MIN_DIRECT_DOCUMENT_HTML_BYTES (5_000).
  const pad = "<!-- " + "x".repeat(4_800) + " -->";

  const scriptPayload = `
<script>
  var data = [
    {"tags":["change"],"author":{"name":"Albert Einstein","slug":"Albert-Einstein"},"text":"thinking quote"},
    {"tags":["choices"],"author":{"name":"J.K. Rowling","slug":"J-K-Rowling"},"text":"choices quote"},
    {"tags":["life"],"author":{"name":"Jane Austen","slug":"Jane-Austen"},"text":"life quote"}
  ];
</script></body></html>`;

  const html = chrome + pad + scriptPayload;

  it("rejects thin chrome when no embedded collection exists", () => {
    const thin = chrome + pad + "</body></html>";
    const r = buildDirectDocumentResult(
      "http://quotes.toscrape.com/js/",
      thin,
      "text/html",
      "list quotes",
    );
    expect(r.rejected).toBe(true);
  });

  it("returns the script payload when chrome is thin but var data = [{…}] is present", () => {
    const r = buildDirectDocumentResult(
      "http://quotes.toscrape.com/js/",
      html,
      "text/html",
      "list quotes",
    );
    expect(r.rejected).toBe(false);
    if (r.rejected) return;
    expect(r.markdown).toContain("Einstein");
    expect(r.markdown).toContain("thinking quote");
    expect(r.text_excerpt).toContain("J.K. Rowling");
    expect(r.extraction.notes.some((n) => n.startsWith("EMBEDDED_COLLECTION:"))).toBe(true);
  });
});
