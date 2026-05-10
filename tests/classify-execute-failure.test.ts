// Falsifiable signal for classifyExecuteFailure
// (src/execution/index.ts, near detectBrowserBlockSignals).
//
// Asserts the executor's post-auth-recovery error classification correctly
// distinguishes vendor_blocked (DataDome / CF / PerimeterX / Akamai / etc.)
// from genuine stale_credentials. Misclassification was the live failure
// observed on leboncoin and cdiscount in the hard-target bench: a DataDome
// 403 was reported as "stale credentials — re-authenticate", causing the
// bench to bucket the URL as AUTH_GATED instead of BROWSER_BLOCK.
//
// Default contract: when no vendor signal matches, return stale_credentials.
// This is strict additive — prior behavior is preserved for non-vendor 403s.

import { describe, it, expect } from "bun:test";
import { classifyExecuteFailure } from "../src/execution/index";

describe("classifyExecuteFailure", () => {
  describe("lost-sheep — the case that motivated this", () => {
    it("classifies DataDome 403 body marker as vendor_blocked (not stale_credentials)", () => {
      // Real DataDome challenge bodies carry the literal "datadome" string
      // in HTML script tags, JS bundle URLs, or the action_message field.
      const r = classifyExecuteFailure({
        status: 403,
        body: '<html><head><script src="https://js.datadome.co/tags.js"></script></head></html>',
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("datadome");
    });

    it("classifies DataDome via Set-Cookie header", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "",
        headers: { "set-cookie": "datadome=abc; Max-Age=86400" },
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("datadome");
    });
  });

  describe("vendor markers", () => {
    it("PerimeterX via _pxhd cookie", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "",
        headers: { "set-cookie": "_pxvid=abc; _pxhd=xyz" },
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("perimeterx");
    });

    it("Akamai Bot Manager via _abck", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "_abck token expired",
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("akamai_bot_manager");
    });

    it("Cloudflare via cf-mitigated header on 403", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "",
        headers: { "cf-mitigated": "challenge", "server": "cloudflare" },
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("cloudflare");
    });

    it("Cloudflare turnstile body marker", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: '<html>cdn-cgi/challenge-platform turnstile</html>',
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("cloudflare");
    });

    it("Imperva Incapsula via reese84", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "<script>reese84 token init</script>",
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("imperva_incapsula");
    });

    it("Kasada via x-kpsdk header", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "",
        headers: { "x-kpsdk-cd": "challenge_data" },
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("kasada");
    });

    it("hCaptcha challenge body", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: '<div class="h-captcha" data-sitekey="abc"></div>',
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("captcha_vendor");
    });
  });

  describe("generic challenge title (no vendor marker)", () => {
    it('"Just a moment..." title → vendor_blocked / generic_challenge', () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "<html><head><title>Just a moment...</title></head><body></body></html>",
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("generic_challenge");
    });

    it('"Access Denied" title', () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "<html><title>Access Denied</title></html>",
      });
      expect(r.kind).toBe("vendor_blocked");
    });

    it('"Verifying you are human" title', () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "<html><title>Verifying you are human</title></html>",
      });
      expect(r.kind).toBe("vendor_blocked");
    });
  });

  describe("preserves stale_credentials default", () => {
    it("generic 403 with no vendor marker → stale_credentials", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: '{"error":"forbidden","message":"insufficient permissions"}',
      });
      expect(r.kind).toBe("stale_credentials");
      expect(r.vendor).toBeUndefined();
    });

    it("401 with no vendor marker → stale_credentials", () => {
      const r = classifyExecuteFailure({
        status: 401,
        body: '{"error":"unauthorized","message":"token expired"}',
      });
      expect(r.kind).toBe("stale_credentials");
    });

    it("empty body 403 → stale_credentials (no signal to override)", () => {
      const r = classifyExecuteFailure({ status: 403, body: "" });
      expect(r.kind).toBe("stale_credentials");
    });
  });

  describe("transient 5xx", () => {
    it("500 → transient", () => {
      const r = classifyExecuteFailure({ status: 500, body: "" });
      expect(r.kind).toBe("transient");
    });

    it("503 → transient", () => {
      const r = classifyExecuteFailure({ status: 503, body: "<html>Service Unavailable</html>" });
      expect(r.kind).toBe("transient");
    });
  });

  describe("input shape robustness", () => {
    it("body as parsed JSON object (not string) — stringifies before scanning", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: { error: "bot detected", details: "datadome blocked you" },
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("datadome");
    });

    it("body=null → stale_credentials default", () => {
      const r = classifyExecuteFailure({ status: 403, body: null });
      expect(r.kind).toBe("stale_credentials");
    });

    it("very large body — only first 16KB scanned (smoke)", () => {
      const big = "a".repeat(100_000) + "datadome";  // marker after 16KB
      const r = classifyExecuteFailure({ status: 403, body: big });
      // marker is past the 16KB sample window, so it should NOT trigger
      expect(r.kind).toBe("stale_credentials");
    });

    it("very large body with marker in first 16KB — detected", () => {
      const big = "datadome" + "a".repeat(100_000);
      const r = classifyExecuteFailure({ status: 403, body: big });
      expect(r.kind).toBe("vendor_blocked");
    });

    it("array of headers (multi-value Set-Cookie)", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "",
        headers: { "set-cookie": ["session=abc", "datadome=xyz"] },
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("datadome");
    });
  });

  describe("divers diseases — adversarial robustness (Step 5)", () => {
    it("legitimate API body mentioning vendor name is NOT misclassified", () => {
      // A real auth API might mention a vendor name in its error message
      // (e.g. "users behind cloudflare must reauth"). Without specific
      // markers (cf-challenge, __cf_chl_, cf-mitigated, turnstile, etc.),
      // narrow regex avoids the false positive.
      const r = classifyExecuteFailure({
        status: 401,
        body: '{"error":"token_expired","note":"users behind cloudflare must reauth"}',
      });
      expect(r.kind).toBe("stale_credentials");
    });

    it("vendor marker is case-insensitive (UPPERCASE DATADOME)", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "BLOCKED BY DATADOME — TOKEN INVALID",
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("datadome");
    });

    it("uppercase H-CAPTCHA also triggers", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: '<DIV CLASS="H-CAPTCHA">',
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("captcha_vendor");
    });

    it("CF mitigated header on status 200 does NOT classify as blocked (gate is 403)", () => {
      // Defensive: real callers only invoke classifier on 401/403, but if
      // a future refactor passes 200 through, vestigial CF headers shouldnt
      // produce a vendor_blocked verdict.
      const r = classifyExecuteFailure({
        status: 200,
        body: "",
        headers: { "cf-mitigated": "challenge" },
      });
      expect(r.kind).toBe("stale_credentials");
    });

    it("status 0 (network failure) with empty body → stale_credentials default", () => {
      const r = classifyExecuteFailure({ status: 0, body: "" });
      expect(r.kind).toBe("stale_credentials");
    });

    it("body as array of chunks — JSON.stringify roundtrip detects markers", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: ["chunk1", "datadome blocked"],
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("datadome");
    });

    it("undefined headers + null body → stale_credentials default", () => {
      const r = classifyExecuteFailure({ status: 403, body: null, headers: undefined });
      expect(r.kind).toBe("stale_credentials");
    });

    it("Kasada via x-kpsdk-cd header alone (no body)", () => {
      const r = classifyExecuteFailure({
        status: 403,
        body: "",
        headers: { "x-kpsdk-cd": "abc.def.ghi" },
      });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("kasada");
    });

    it("real leboncoin DataDome 403 body (captcha-delivery marker)", () => {
      // Verbatim sample from production: leboncoin.fr DataDome 403 body
      // when libcurl is identified as a bot. The literal string "datadome"
      // never appears in the body; the markers are the captcha-delivery.com
      // CDN reference and the var dd={ ... rt:c shape.
      const realBody = `<html lang="en"><head><title>leboncoin.fr</title><style>#cmsg{animation: A 1.5s;}</style></head><body><p id="cmsg">Please enable JS and disable any ad blocker</p><script data-cfasync="false">var dd={'rt':'c','cid':'AHrlqAAAAAMA','host':'geo.captcha-delivery.com'}</script><script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`;
      const r = classifyExecuteFailure({ status: 403, body: realBody });
      expect(r.kind).toBe("vendor_blocked");
      expect(r.vendor).toBe("datadome");
    });
  });
});
