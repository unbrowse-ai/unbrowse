/**
 * Tests for the Cloudflare challenge bundle helpers (plan-v13 Tier 2A seed).
 *
 * Run: bun test src/execution/cf-challenge.test.ts
 */
import { describe, it, expect } from "bun:test";
import {
  extractCfBundleUrl,
  solveCfAndRetry,
} from "./cf-challenge.js";

describe("extractCfBundleUrl", () => {
  it("returns absolute URL when CF challenge HTML contains /cdn-cgi/challenge-platform/h/g/scripts/jsd/<hash>/main.js", () => {
    const body = `<!doctype html><html><head><title>Just a moment...</title>
<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/a1b2c3d4ef/main.js"></script>
</head><body></body></html>`;
    const got = extractCfBundleUrl(body, "https://example.com/protected");
    expect(got).toBe(
      "https://example.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/a1b2c3d4ef/main.js",
    );
  });

  it("returns null for non-CF analytics paths like /cdn-cgi/scripts/email-decode/email-decode.min.js", () => {
    const body = `<html><head>
<script src="/cdn-cgi/scripts/email-decode/email-decode.min.js"></script>
</head></html>`;
    const got = extractCfBundleUrl(body, "https://example.com/page");
    expect(got).toBeNull();
  });

  it("matches the /h/b/ (bot management) variant in addition to /h/g/", () => {
    const body = `<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/deadbeef00/main.js"></script>`;
    const got = extractCfBundleUrl(body, "https://example.com/protected");
    expect(got).toBe(
      "https://example.com/cdn-cgi/challenge-platform/h/b/scripts/jsd/deadbeef00/main.js",
    );
  });

  it("matches uppercase hex hashes because the regex carries the /i flag", () => {
    const body = `<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/ABCDEF0123/main.js"></script>`;
    const got = extractCfBundleUrl(body, "https://example.com/protected");
    expect(got).toBe(
      "https://example.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/ABCDEF0123/main.js",
    );
  });

  it("prefers the challenge bundle URL when an analytics path is also present in the body", () => {
    const body = `<html><head>
<script src="/cdn-cgi/scripts/email-decode/email-decode.min.js"></script>
<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface99/main.js"></script>
</head></html>`;
    const got = extractCfBundleUrl(body, "https://example.com/protected");
    expect(got).toBe(
      "https://example.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface99/main.js",
    );
  });

  it("returns null for raw HTML/JSON bodies that contain no CF references at all", () => {
    const body = `<!doctype html><html><body><h1>Welcome</h1><pre>{"items":[1,2,3]}</pre></body></html>`;
    const got = extractCfBundleUrl(body, "https://example.com/api/data");
    expect(got).toBeNull();
  });

  it("returns null when only a query-stringed CF challenge URL is present without the main.js script tag (documents current gap)", () => {
    const body = `<html><body><a href="/?cf_chl=abc&__cf_chl_jschl_tk__=xyz">retry</a></body></html>`;
    const got = extractCfBundleUrl(body, "https://example.com/protected");
    expect(got).toBeNull();
  });

  it("preserves https scheme when resolving a relative bundle path against an https requestUrl", () => {
    const body = `<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/0123456789/main.js"></script>`;
    const got = extractCfBundleUrl(body, "https://secure.example.com/x/y?z=1");
    expect(got).toBe(
      "https://secure.example.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/0123456789/main.js",
    );
  });
});

describe("solveCfAndRetry", () => {
  it("returns null when body contains no CF bundle reference", async () => {
    const got = await solveCfAndRetry({
      url: "https://example.com/protected",
      body: "<html>challenge</html>",
    });
    expect(got).toBeNull();
  });

  it("returns null when the fetched bundle source is < 1024 bytes (short-circuit before sandbox)", async () => {
    const origFetch = globalThis.fetch;
    let calls = 0;
    // @ts-expect-error - test override
    globalThis.fetch = async (_url: string) => {
      calls += 1;
      return new Response("tiny", { status: 200 });
    };
    try {
      const got = await solveCfAndRetry({
        url: "https://example.com/protected",
        body: `<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/abc123/main.js"></script>`,
      });
      expect(got).toBeNull();
      // Bundle fetch attempted exactly once; retry fetch never happens.
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns null when bundle fetch is non-200", async () => {
    const origFetch = globalThis.fetch;
    // @ts-expect-error - test override
    globalThis.fetch = async () => new Response("nope", { status: 403 });
    try {
      const got = await solveCfAndRetry({
        url: "https://example.com/protected",
        body: `<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/abc123/main.js"></script>`,
      });
      expect(got).toBeNull();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
