/**
 * Luminary test for plan-v14-cf-capture Step 3 seed at
 * src/execution/index.ts:1358-1375.
 *
 * The seed inside `executeBrowserCapture` invokes `extractCfBundleUrl` to
 * decide whether to enter the CF solver path. We can't unit-test the seed
 * directly without a full kuri sandbox spinup, so we lock in the helper's
 * behavioral contract — when the helper drifts, the seed's detection signal
 * silently breaks. Mirrors cf-challenge.test.ts but scoped to seed semantics.
 */

import { describe, expect, test } from "bun:test";
import { extractCfBundleUrl } from "./cf-challenge.js";

describe("cf-capture seed: extractCfBundleUrl detection contract", () => {
  test("happy detection — CF challenge HTML returns absolute bundle URL", () => {
    const body =
      `<!DOCTYPE html><html><head><title>Just a moment...</title></head>` +
      `<body><div class="cf-wrapper">Checking your browser...</div>` +
      `<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface00/main.js"></script>` +
      `</body></html>`;
    const result = extractCfBundleUrl(body, "https://www.indeed.com/jobs?q=software");
    expect(result).not.toBeNull();
    expect(result).toContain("cdn-cgi/challenge-platform");
    expect(result).toBe(
      "https://www.indeed.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface00/main.js",
    );
  });

  test("negative — normal Next.js page returns null (no false positives)", () => {
    const body =
      `<!DOCTYPE html><html><head><title>Software Engineer Jobs</title></head>` +
      `<body><div id="__next"><h1>Search results</h1>` +
      `<script src="/_next/static/chunks/main-abc123.js"></script>` +
      `<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>` +
      `</div></body></html>`;
    const result = extractCfBundleUrl(body, "https://www.indeed.com/jobs?q=software");
    expect(result).toBeNull();
  });

  test("negative — CF email-decode (non-challenge cdn-cgi) returns null", () => {
    const body =
      `<!DOCTYPE html><html><head><title>Contact</title></head>` +
      `<body><a href="/cdn-cgi/l/email-protection#abc">email</a>` +
      `<script defer src="/cdn-cgi/scripts/email-decode/email-decode.min.js"></script>` +
      `</body></html>`;
    const result = extractCfBundleUrl(body, "https://example.com/contact");
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Adversarial cases (Day 5 Creatures sub-agent B, plan-v14-cf-capture)
  // ---------------------------------------------------------------------------

  test("adversarial 1 — multi-line script tag with attributes between matches", () => {
    const body =
      `<!DOCTYPE html><html><body>` +
      `<script defer\n  src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface00/main.js"\n  data-cf="abc"></script>` +
      `</body></html>`;
    const result = extractCfBundleUrl(body, "https://www.indeed.com/jobs?q=software");
    expect(result).toBe(
      "https://www.indeed.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface00/main.js",
    );
  });

  test("adversarial 2 — bundle URL inside HTML comment returns null (Step 6 tightening)", () => {
    // CF_BUNDLE_RE now requires a `src="` or `src='` prefix immediately before
    // the bundle path. A comment-only body has no such prefix, so this
    // returns null — the helper no longer false-positives on comment-leaked
    // paths and won't waste a kuri sandbox slot fetching a bogus URL.
    // (plan-v14-cf-capture Step 6 Dominion sub-agent D, .)
    const body = `<!-- /cdn-cgi/challenge-platform/h/g/scripts/jsd/abc/main.js -->`;
    const result = extractCfBundleUrl(body, "https://example.com/x");
    expect(result).toBeNull();
  });

  test("adversarial 3 — bundle URL with query string returns path only", () => {
    const body =
      `<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/abc/main.js?v=12345"></script>`;
    const result = extractCfBundleUrl(body, "https://example.com/");
    // Regex stops at `.js`, so `?v=12345` should NOT appear in the result.
    expect(result).toBe(
      "https://example.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/abc/main.js",
    );
    expect(result).not.toContain("v=12345");
  });

  test("adversarial 4 — mixed-case path matches due to /i flag", () => {
    const body =
      `<script src="/cdn-cgi/Challenge-Platform/h/g/scripts/jsd/feedface00/main.js"></script>`;
    const result = extractCfBundleUrl(body, "https://example.com/");
    // CURRENT BEHAVIOR: regex uses /i flag, so "Challenge-Platform" matches.
    // URL constructor preserves the original casing. Real CF serves the path
    // lowercase, so an uppercase variant is never observed in the wild — the
    // helper accepts it. Documented, not (yet) a bug.
    expect(result).toBe(
      "https://example.com/cdn-cgi/Challenge-Platform/h/g/scripts/jsd/feedface00/main.js",
    );
  });

  test("adversarial 5 — empty / null / undefined body does not throw", () => {
    expect(extractCfBundleUrl("", "https://example.com")).toBeNull();
    // The helper guards `!body || typeof body !== "string"` so null/undefined
    // are clean null returns, not TypeError or regex panic.
    expect(() => extractCfBundleUrl(null as any, "https://example.com")).not.toThrow();
    expect(extractCfBundleUrl(null as any, "https://example.com")).toBeNull();
    expect(() => extractCfBundleUrl(undefined as any, "https://example.com")).not.toThrow();
    expect(extractCfBundleUrl(undefined as any, "https://example.com")).toBeNull();
  });

  // Day-5 (Creatures) sub-agent D adversarial probes against the seed at
  // src/execution/index.ts:1358-1375. The seed already guards `typeof
  // captured.html === "string" && captured.html.length > 0`, which covers the
  // undefined-captured-html and empty-string degraded conditions. These cases
  // lock in that even when kuri evaluate returns garbage that PASSES the
  // typeof+length gate, extractCfBundleUrl rejects it cleanly (returns null,
  // does not throw, does not false-match).
  test("degraded — kuri returned literal '[object Object]' string returns null", () => {
    // CLAUDE.md "Guard kuri evaluate results" notes this exact failure mode:
    // kuri.getPageHtml occasionally returns the string "[object Object]" when
    // the CDP response shape changes. The seed currently passes this through
    // to extractCfBundleUrl unfiltered. Lock in null-return so the seed never
    // false-positives a CF bundle on this garbage.
    const result = extractCfBundleUrl(
      "[object Object]",
      "https://example.com/path",
    );
    expect(result).toBeNull();
  });

  test("degraded — arbitrary garbage with no html structure returns null", () => {
    const result = extractCfBundleUrl(
      "garbage with no html structure at all",
      "https://example.com/path",
    );
    expect(result).toBeNull();
  });
});
