import { describe, expect, test } from "bun:test";
import {
  buildBloombergDirectDocumentResult,
  isBloombergDirectDocumentUrl,
} from "../src/orchestrator/direct-document.js";

describe("Bloomberg direct-document seed", () => {
  test("accepts a large Bloomberg HTML document as a direct-document result", () => {
    const html = `<!doctype html><html><head><title>Markets - Bloomberg</title></head><body><main><h1>Markets</h1>${"Bloomberg market data ".repeat(400)}</main></body></html>`;

    const result = buildBloombergDirectDocumentResult(
      "https://www.bloomberg.com/markets",
      html,
      "text/html; charset=utf-8",
    );

    expect(result.rejected).toBe(false);
    if (result.rejected) throw new Error(result.reason);
    expect(result.title).toBe("Markets - Bloomberg");
    expect(result.extraction.source).toBe("direct-document");
    expect(result.text_excerpt).toContain("Bloomberg market data");
  });

  test("rejects challenge-shaped Bloomberg HTML", () => {
    const html = `<!doctype html><html><head><title>Access Denied</title></head><body>${"verify you are human ".repeat(400)}</body></html>`;

    const result = buildBloombergDirectDocumentResult(
      "https://www.bloomberg.com/markets",
      html,
      "text/html",
    );

    expect(result).toEqual({ rejected: true, reason: "challenge_html" });
  });

  test("does not reject challenge words hidden inside scripts", () => {
    const html = `<!doctype html><html><head><title>Markets - Bloomberg</title><script>window.copy = "verify you are human";</script></head><body>${"Live market data ".repeat(400)}</body></html>`;

    const result = buildBloombergDirectDocumentResult(
      "https://www.bloomberg.com/markets",
      html,
      "text/html",
    );

    expect(result.rejected).toBe(false);
    if (result.rejected) throw new Error(result.reason);
    expect(result.text_excerpt).toContain("Live market data");
    expect(result.text_excerpt).not.toContain("verify you are human");
  });

  test("rejects non-html and too-small documents before extracting text", () => {
    expect(
      buildBloombergDirectDocumentResult(
        "https://www.bloomberg.com/markets",
        JSON.stringify({ title: "Markets - Bloomberg" }),
        "application/json",
      ),
    ).toEqual({ rejected: true, reason: "not_html" });

    expect(
      buildBloombergDirectDocumentResult(
        "https://www.bloomberg.com/markets",
        "<!doctype html><title>Markets - Bloomberg</title>",
        "text/html",
      ),
    ).toEqual({ rejected: true, reason: "too_small" });
  });

  test("decodes HTML entities in direct document title and text", () => {
    const html = `<!doctype html><html><head><title>Markets &amp; Data - Bloomberg</title></head><body>${"Rates &amp; bonds ".repeat(400)}</body></html>`;

    const result = buildBloombergDirectDocumentResult(
      "https://www.bloomberg.com/markets",
      html,
      "text/html",
    );

    expect(result.rejected).toBe(false);
    if (result.rejected) throw new Error(result.reason);
    expect(result.title).toBe("Markets & Data - Bloomberg");
    expect(result.text_excerpt).toContain("Rates & bonds");
  });

  test("keeps the seed scoped to Bloomberg", () => {
    expect(isBloombergDirectDocumentUrl("https://www.bloomberg.com/markets")).toBe(true);
    expect(isBloombergDirectDocumentUrl("https://assets.bloomberg.com/page")).toBe(true);
    expect(isBloombergDirectDocumentUrl("https://example.com/markets")).toBe(false);
  });
});
