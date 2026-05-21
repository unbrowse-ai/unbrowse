import { describe, expect, test } from "bun:test";
import {
  buildBloombergDirectDocumentResult,
  buildDirectDocumentResult,
  isBloombergDirectDocumentUrl,
  isDirectDocumentEligibleUrl,
} from "../src/orchestrator/direct-document.js";

describe("direct-document seed", () => {
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

  test("eligibility gate is now generic (HTTP/HTTPS only, no per-host arm)", () => {
    // Per CLAUDE.md substrate principle, the prior per-host bloomberg gate
    // was retired. Any http(s) URL is eligible — the HTML/size/challenge
    // gates inside buildDirectDocumentResult do the real work, generically.
    // Bench-cycle-3 motivation: stackoverflow probes 016/017 got 39-byte
    // empty Kuri snapshots while the live SSR page is 200KB+; without the
    // generalization those probes had no fallback path.
    expect(isDirectDocumentEligibleUrl("https://www.bloomberg.com/markets")).toBe(true);
    expect(isDirectDocumentEligibleUrl("https://stackoverflow.com/questions/11227809")).toBe(true);
    expect(isDirectDocumentEligibleUrl("https://example.com/markets")).toBe(true);
    expect(isDirectDocumentEligibleUrl("ftp://files.example.com/dump")).toBe(false);
    expect(isDirectDocumentEligibleUrl("not-a-url")).toBe(false);
    // Deprecated alias still works (one-release transition window).
    expect(isBloombergDirectDocumentUrl("https://www.bloomberg.com/markets")).toBe(true);
    expect(isBloombergDirectDocumentUrl("https://stackoverflow.com/questions/11227809")).toBe(true);
  });

  test("buildDirectDocumentResult accepts non-bloomberg sites with real SSR content", () => {
    const html = `<!doctype html><html><head><title>Why is processing a sorted array faster than processing an unsorted array? - Stack Overflow</title></head><body><main><h1>Why is processing a sorted array faster</h1>${"Real Stack Overflow answer content ".repeat(400)}</main></body></html>`;
    const result = buildDirectDocumentResult(
      "https://stackoverflow.com/questions/11227809",
      html,
      "text/html; charset=utf-8",
    );
    expect(result.rejected).toBe(false);
    if (result.rejected) throw new Error(result.reason);
    expect(result.title).toContain("Stack Overflow");
    expect(result.text_excerpt).toContain("Real Stack Overflow answer content");
    expect(result.extraction.source).toBe("direct-document");
  });

  test("challenge / too-small / not-html rejections still fire generically", () => {
    const challenge = `<!doctype html><html><head><title>Just a moment...</title></head><body>${"verify you are human ".repeat(400)}</body></html>`;
    expect(buildDirectDocumentResult("https://stackoverflow.com/questions/11227809", challenge, "text/html"))
      .toEqual({ rejected: true, reason: "challenge_html" });

    expect(buildDirectDocumentResult("https://example.com/page", "<html><title>X</title></html>", "text/html"))
      .toEqual({ rejected: true, reason: "too_small" });

    expect(buildDirectDocumentResult("https://example.com/api", JSON.stringify({}), "application/json"))
      .toEqual({ rejected: true, reason: "not_html" });
  });
});
