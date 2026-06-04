// Falsifier for plan-v12 Phase A — guards two regex token additions in
// detectBrowserBlockSignals at src/execution/index.ts:
//   1. captcha-delivery.com → vendor:datadome
//   2. cdn-cgi/challenge-platform → vendor:cloudflare
//
// Fixtures lifted from real bench-history rejected_samples for g2.com
// and leboncoin.fr (run 20260509T030602Z).

import { describe, it, expect } from "bun:test";
import { detectBrowserBlockSignals } from "../src/execution/index";

describe("plan-v12: vendor URL fingerprint coverage", () => {
  it("emits vendor:datadome for captcha-delivery.com URL (leboncoin fixture)", () => {
    const signals = detectBrowserBlockSignals({
      requestUrls: [
        "https://geo.captcha-delivery.com/captcha/?initialCid=AHrlqAAAAAMA2RLczKajze8AdFidnw%3D%3D",
        "https://www.leboncoin.fr/favicon.ico",
      ],
      title: "leboncoin.fr",
      htmlLength: 1522,
      rejectionCounts: { not_api_like: 4 },
    });
    expect(signals).toContain("vendor:datadome");
  });

  it("emits vendor:cloudflare for cdn-cgi/challenge-platform URL", () => {
    const signals = detectBrowserBlockSignals({
      requestUrls: [
        "https://www.g2.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/fe6331af5207/main.js",
      ],
      title: "g2.com",
      htmlLength: 2593,
      rejectionCounts: { not_api_like: 5 },
    });
    expect(signals).toContain("vendor:cloudflare");
  });

  it("emits BOTH vendor signals for g2.com (CF + DataDome combined)", () => {
    const signals = detectBrowserBlockSignals({
      requestUrls: [
        "https://geo.captcha-delivery.com/captcha/?initialCid=X",
        "https://www.g2.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js",
      ],
      title: "g2.com",
      htmlLength: 2593,
      rejectionCounts: { not_api_like: 5 },
    });
    expect(signals).toContain("vendor:datadome");
    expect(signals).toContain("vendor:cloudflare");
  });

  it("does NOT false-match on similar-looking but unrelated hosts (boundary)", () => {
    const signals = detectBrowserBlockSignals({
      // This is a real-world false-positive risk — site name happens to
      // include "cdn-cgi" but is NOT cloudflare's challenge platform.
      requestUrls: [
        "https://not-cdn-cgi.example.com/blog/post",
        "https://example.com/articles/captcha-research",
      ],
      title: "Tech Blog Post",
      htmlLength: 50000,
      rejectionCounts: {},
    });
    expect(signals).not.toContain("vendor:datadome");
    expect(signals).not.toContain("vendor:cloudflare");
  });

  it("does NOT false-match cdn-cgi analytics (only challenge-platform)", () => {
    // Cloudflare's general /cdn-cgi/scripts/* path is for analytics
    // beacons, not challenges. Only /cdn-cgi/challenge-platform/* should
    // tag vendor:cloudflare.
    const signals = detectBrowserBlockSignals({
      requestUrls: [
        "https://example.com/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js",
      ],
      title: "Site",
      htmlLength: 50000,
      rejectionCounts: {},
    });
    expect(signals).not.toContain("vendor:cloudflare");
  });

  it("preserves prior datadome detection patterns (regression check)", () => {
    // The original tokens (datadome|js.datadome|dd.datadome|_dd.s|ddjskey)
    // must still fire — adding captcha-delivery.com must not break them.
    const signals = detectBrowserBlockSignals({
      requestUrls: ["https://js.datadome.co/js.js"],
      title: "Site",
      htmlLength: 5000,
      rejectionCounts: {},
    });
    expect(signals).toContain("vendor:datadome");
  });

  it("preserves prior cloudflare detection patterns (regression check)", () => {
    const signals = detectBrowserBlockSignals({
      requestUrls: ["https://challenges.cloudflare.com/turnstile/v0/api.js"],
      title: "Site",
      htmlLength: 5000,
      rejectionCounts: {},
    });
    expect(signals).toContain("vendor:cloudflare");
  });
});
