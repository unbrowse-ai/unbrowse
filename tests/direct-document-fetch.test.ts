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

  test("rejects logged-out / interstitial bodies that previously passed structural gates", () => {
    // Gmail-style sign-in wall (>5KB so it clears too_small, but body is auth-wall)
    const gmail = `<!doctype html><html><head><title>Gmail</title></head><body><div>${"Sign in to continue to Gmail ".repeat(400)}</div></body></html>`;
    const result = buildDirectDocumentResult(
      "https://mail.google.com/mail/u/0/#inbox",
      gmail,
      "text/html",
      "get gmail inbox messages",
    );
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("interstitial_detected");
    expect(result.evidence?.interstitial_signal?.toLowerCase()).toContain("sign in to continue");
  });

  test("rejects x.com JavaScript-not-available interstitial generically", () => {
    const x = `<!doctype html><html><head><title>X</title></head><body><noscript>${"JavaScript is not available. We've detected that JavaScript is disabled in this browser. ".repeat(80)}</noscript></body></html>`;
    const result = buildDirectDocumentResult(
      "https://x.com/home",
      x,
      "text/html",
      "get my x timeline",
    );
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("interstitial_detected");
    expect(result.evidence?.interstitial_signal?.toLowerCase()).toContain("javascript is not available");
  });

  test("rejects cloudflare 'please wait for verification' interstitial across hosts", () => {
    const cf = `<!doctype html><html><head><title>Reddit</title></head><body>${"Reddit Please wait for verification ".repeat(400)}</body></html>`;
    const result = buildDirectDocumentResult(
      "https://www.reddit.com/r/singularity/",
      cf,
      "text/html",
      "get reddit singularity posts",
    );
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("interstitial_detected");
  });

  test("rejects intent-mismatch bodies when intent tokens score below 0.34", () => {
    // 5KB+ HTML, no interstitial markers, but talks about cooking when intent
    // asks about hacker news stories. The 4 meaningful tokens [hacker, news,
    // stories, ranked] would score 0/4 = 0.0 hits.
    const wrongPage = `<!doctype html><html><head><title>Cooking recipes</title></head><body>${"Bake the bread for forty minutes at three hundred fifty degrees. ".repeat(200)}</body></html>`;
    const result = buildDirectDocumentResult(
      "https://example.com/cooking",
      wrongPage,
      "text/html",
      "get hacker news ranked stories",
    );
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("intent_mismatch");
    expect(result.evidence?.response_token_hit_rate).toBe(0);
    expect(result.evidence?.intent_tokens).toEqual(expect.arrayContaining(["hacker", "news", "stories", "ranked"]));
  });

  test("accepts a result with intent token overlap >= 0.34", () => {
    // HN-shaped result with token overlap on hacker + news + stories
    const hn = `<!doctype html><html><head><title>Hacker News</title></head><body>${"Hacker News top stories show the most upvoted submissions ranked by score. ".repeat(150)}</body></html>`;
    const result = buildDirectDocumentResult(
      "https://news.ycombinator.com/",
      hn,
      "text/html",
      "get hacker news ranked stories",
    );
    expect(result.rejected).toBe(false);
    if (result.rejected) throw new Error(result.reason);
    expect(result.title).toBe("Hacker News");
  });

  test("does not run intent gate without intent (back-compat)", () => {
    // 3-arg call form still works exactly as before.
    const html = `<!doctype html><html><head><title>Cooking</title></head><body>${"Bake bread ".repeat(500)}</body></html>`;
    const result = buildDirectDocumentResult(
      "https://example.com/cooking",
      html,
      "text/html",
    );
    expect(result.rejected).toBe(false);
  });

  test("rejects 86-byte SPA meta-only envelope as interstitial", () => {
    // Construct a >5KB HTML (clears MIN_DIRECT_DOCUMENT_HTML_BYTES) where the
    // visible body text after script/style stripping is below
    // MIN_DIRECT_DOCUMENT_BODY_TEXT. SPA shells with massive inline scripts hit
    // this in production (dribbble tag pages 2026-05-21).
    const spaShell = `<!doctype html><html><head><title>Landing pages</title><script>${"window.__DATA__ = 1;".repeat(500)}</script></head><body><div id="root"></div></body></html>`;
    const result = buildDirectDocumentResult(
      "https://dribbble.com/tags/landing-page",
      spaShell,
      "text/html",
      "get dribbble landing-page tag",
    );
    expect(result.rejected).toBe(true);
    if (!result.rejected) throw new Error("expected rejection");
    expect(result.reason).toBe("interstitial_detected");
    expect(result.evidence?.interstitial_signal).toMatch(/body_text_below_floor/);
  });
});
