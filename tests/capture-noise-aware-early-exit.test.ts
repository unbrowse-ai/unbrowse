import { describe, it, expect } from "bun:test";
import {
  isApiShapedUrl,
  hasApiShapedBody,
  API_URL_PATTERN,
} from "../src/capture/index.js";

// Pins issue #98 (SPA network-idle: wait for lazy-loaded API calls).
//
// Pre-fix root cause (per maintainer comment 2026-05-19):
// waitForContentReady's early-exit at Phase 1 bailed the moment
// responseBodies.size > 0. On dashboard SPAs (ads.x.com,
// music.youtube.com) the in-flight map is non-empty within ~1s (HTML
// shell, bundle JS chunks, analytics/config pings), so the real data
// XHR that fires 2-5s into React hydration was never seen.
//
// Fix: gate the early-exit on hasApiShapedBody — only declare "captured
// enough" when at least one body is API-shaped per the same URL pattern
// the CDP auto-fetch path uses. The bare .size>0 check is dead.
//
// No mocks, no kuri, no live browser. If these helpers regress, the
// noise-aware early-exit silently reverts to the eager bail.

describe("#98 noise-aware early-exit: isApiShapedUrl", () => {
  it("classifies /api/ paths as API-shaped (LinkedIn voyager, X /i/api)", () => {
    expect(isApiShapedUrl("https://x.com/i/api/2/timeline/home.json")).toBe(true);
    expect(isApiShapedUrl("https://www.linkedin.com/voyager/api/feed/updates")).toBe(true);
  });

  it("classifies /graphql paths as API-shaped (X.com Apollo, GitHub GraphQL)", () => {
    expect(isApiShapedUrl("https://api.github.com/graphql")).toBe(true);
    expect(isApiShapedUrl("https://x.com/i/api/graphql/abc123/HomeTimeline")).toBe(true);
  });

  it("classifies versioned API paths (/v1/, /v3/) as API-shaped", () => {
    expect(isApiShapedUrl("https://ads.x.com/v1/accounts/123/campaigns")).toBe(true);
    expect(isApiShapedUrl("https://example.com/v3/users/me")).toBe(true);
  });

  it("classifies YouTube/Music internal API path as API-shaped", () => {
    expect(
      isApiShapedUrl("https://music.youtube.com/youtubei/v1/browse?prettyPrint=false"),
    ).toBe(true);
  });

  it("rejects HTML shell + bundle JS + analytics pings as NOT API-shaped", () => {
    // The exact noise that the pre-fix early-exit ate as a green light:
    expect(isApiShapedUrl("https://ads.x.com/")).toBe(false); // HTML shell
    expect(isApiShapedUrl("https://ads.x.com/static/bundle.abc123.js")).toBe(false);
    expect(isApiShapedUrl("https://music.youtube.com/")).toBe(false);
    expect(isApiShapedUrl("https://www.linkedin.com/sw.js")).toBe(false);
    expect(isApiShapedUrl("https://x.com/static/main.css")).toBe(false);
    // Analytics / telemetry pings
    expect(isApiShapedUrl("https://x.com/i/jot/")).toBe(false);
  });

  it("is case-insensitive (CDN-normalized URLs sometimes uppercase)", () => {
    expect(isApiShapedUrl("https://X.COM/I/API/USER")).toBe(true);
    expect(isApiShapedUrl("https://X.COM/GRAPHQL/abc")).toBe(true);
  });

  it("API_URL_PATTERN export mirrors the CDP auto-fetch path constant", () => {
    // Documented invariant: the module-level export drives both the
    // waitForContentReady early-exit gate AND any downstream call site
    // that needs the same notion of "API-shaped". The regex literal is
    // byte-identical to the inline CDP-auto-fetch use.
    expect(API_URL_PATTERN.test("/api/x")).toBe(true);
    expect(API_URL_PATTERN.test("/graphql")).toBe(true);
    expect(API_URL_PATTERN.test("/voyager/feed")).toBe(true);
    expect(API_URL_PATTERN.test("/youtubei/v1/browse")).toBe(true);
    expect(API_URL_PATTERN.test("/v1/x")).toBe(true);
    expect(API_URL_PATTERN.test("/v99/x")).toBe(true);
    expect(API_URL_PATTERN.test("/")).toBe(false);
    expect(API_URL_PATTERN.test("/static/bundle.js")).toBe(false);
  });
});

describe("#98 noise-aware early-exit: hasApiShapedBody (the gate)", () => {
  it("returns false for a map containing ONLY noise (the pre-fix bug repro)", () => {
    // This is the exact pre-fix failure mode: responseBodies.size > 0
    // because the HTML shell and bundle JS landed, but no API has yet
    // returned. Pre-fix the gate fired and waitForContentReady bailed
    // before React hydration could trigger the real data XHR.
    const noise = new Map<string, string>([
      ["https://ads.x.com/", "<!DOCTYPE html>..."],
      ["https://ads.x.com/static/main.abc.js", "/*! bundle */"],
      ["https://ads.x.com/static/vendor.xyz.js", "/*! vendor */"],
    ]);
    expect(hasApiShapedBody(noise.keys())).toBe(false);
  });

  it("returns true the moment ONE API-shaped body lands among noise", () => {
    // Post-fix: a single real /api/ XHR landing alongside the shell+JS
    // flips the gate green so capture can declare "enough" and exit
    // with the actual data in hand.
    const mixed = new Map<string, string>([
      ["https://ads.x.com/", "<!DOCTYPE html>..."],
      ["https://ads.x.com/static/main.abc.js", "/*! bundle */"],
      ["https://ads.x.com/v1/accounts/123/campaigns", '{"data": []}'],
    ]);
    expect(hasApiShapedBody(mixed.keys())).toBe(true);
  });

  it("returns false for an empty map (defensive base case)", () => {
    expect(hasApiShapedBody([])).toBe(false);
    expect(hasApiShapedBody(new Map<string, string>().keys())).toBe(false);
  });

  it("recognizes the issue #98 reporter cases: ads.x.com + music.youtube.com", () => {
    // Reporter said: "cookies stored 17, 0 endpoints" — meaning many
    // response bodies in the map (good cookies), but NO API-shaped one,
    // which is exactly what the noise-aware gate must NOT mistake for
    // "captured enough". Falsifier: if this returns true on
    // shell-only, the pre-fix bug is back.
    const adsXcomNoise = [
      "https://ads.x.com/",
      "https://ads.x.com/manifest.json",
      "https://ads.x.com/static/runtime.js",
      "https://abs.twimg.com/responsive-web/client-web/main.abc.js",
    ];
    expect(hasApiShapedBody(adsXcomNoise)).toBe(false);

    const musicYtNoise = [
      "https://music.youtube.com/",
      "https://music.youtube.com/sw.js",
      "https://www.gstatic.com/youtube/img/promos/growth/x.svg",
    ];
    expect(hasApiShapedBody(musicYtNoise)).toBe(false);

    // And the post-hydration moment when the real API DOES fire:
    const adsXcomReal = [...adsXcomNoise, "https://ads.x.com/v1/accounts/me/campaigns"];
    expect(hasApiShapedBody(adsXcomReal)).toBe(true);

    const musicYtReal = [
      ...musicYtNoise,
      "https://music.youtube.com/youtubei/v1/browse",
    ];
    expect(hasApiShapedBody(musicYtReal)).toBe(true);
  });
});
