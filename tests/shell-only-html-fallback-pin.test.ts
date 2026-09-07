// Regression pin for the shell-only-HTML fallback in cacheBrowseRequests.
//
// Cycle-4 evidence: probes 016/017 stackoverflow returned
// `<html><head></head><body></body></html>` from kuri's getPageHtml,
// extraction returned nothing, no_dom_data fired, server-fetch fallback
// was gated on `!html.trimStart().startsWith("<")` which the shell
// silently passed. The fix expands the predicate to ALSO trigger on
// shell-only HTML (a tiny doc that strips to nothing after removing
// html/head/body wrappers).
//
// This test exercises the predicate via source inspection (no runtime
// dependency on kuri/playwright). If a future refactor re-introduces
// the narrower predicate, this pin fails.
//
// Run: bun test tests/shell-only-html-fallback-pin.test.ts

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "..", "src", "api", "browse-index.ts"),
  "utf8",
);

describe("shell-only HTML fallback in cacheBrowseRequests", () => {
  test("looksLikeShellOnly predicate is declared", () => {
    expect(SRC).toContain("const looksLikeShellOnly");
  });

  test("server-fetch fallback triggers on shell-only HTML", () => {
    // The combined condition must accept the empty-shell case.
    expect(SRC).toContain('looksLikeShellOnly(html)');
    // And it must still accept the original malformed-html case.
    expect(SRC).toContain('!html.trimStart().startsWith("<") || looksLikeShellOnly(html)');
  });

  test("looksLikeShellOnly strips html/head/body wrappers", () => {
    // Pin the regex shape so a refactor cannot silently drop one wrapper.
    expect(SRC).toContain("/<\\/?html\\b[^>]*>/gi");
    expect(SRC).toContain("/<\\/?head\\b[^>]*>/gi");
    expect(SRC).toContain("/<\\/?body\\b[^>]*>/gi");
  });

  test("predicate behavior matches the live stackoverflow capture", () => {
    // Inline the predicate so the test can exercise the actual shape
    // without importing the whole module (cacheBrowseRequests pulls in
    // capture / extraction / execution which need kuri).
    const looksLikeShellOnly = (h: string | undefined): boolean => {
      if (!h) return false;
      if (h.length > 600) return false;
      const inner = h
        .replace(/<\/?html\b[^>]*>/gi, "")
        .replace(/<\/?head\b[^>]*>/gi, "")
        .replace(/<\/?body\b[^>]*>/gi, "")
        .trim();
      return inner.length === 0;
    };
    // The exact bytes kuri returned on cycle-4 stackoverflow probes
    expect(looksLikeShellOnly("<html><head></head><body></body></html>")).toBe(true);
    // Tolerant of attributes
    expect(looksLikeShellOnly('<html lang="en"><head></head><body class="x"></body></html>')).toBe(true);
    // Whitespace only
    expect(looksLikeShellOnly("<html><head></head><body>   </body></html>")).toBe(true);
    // Real content stays unflagged
    expect(looksLikeShellOnly("<html><head></head><body><h1>Hi</h1></body></html>")).toBe(false);
    // Anything over 600 bytes is presumed real (cheap guard)
    expect(looksLikeShellOnly("<html><head></head><body>" + "a".repeat(700) + "</body></html>")).toBe(false);
    // Empty input
    expect(looksLikeShellOnly(undefined)).toBe(false);
    expect(looksLikeShellOnly("")).toBe(false);
  });
});
