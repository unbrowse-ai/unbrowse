// Unit tests for detectBrowserBlockSignals — the signal detector behind
// browser_block_signals in captured_meta. These lock in every detection
// rule so the agent/harness can rely on consistent classification.

import { describe, expect, it } from "bun:test";
import { detectBrowserBlockSignals } from "../src/execution/index.js";

function detect(overrides: Partial<Parameters<typeof detectBrowserBlockSignals>[0]> = {}) {
  return detectBrowserBlockSignals({
    requestUrls: [],
    title: "",
    htmlLength: 5000,
    rejectionCounts: {},
    ...overrides,
  });
}

describe("detectBrowserBlockSignals", () => {
  it("returns empty array for a normal successful capture", () => {
    expect(detect({
      requestUrls: ["https://example.com/api/data"],
      title: "Example Domain",
      htmlLength: 10000,
    })).toEqual([]);
  });

  describe("challenge_title", () => {
    it("fires on cloudflare just-a-moment", () => {
      expect(detect({ title: "Just a moment..." })).toContain("challenge_title");
    });
    it("fires on attention required", () => {
      expect(detect({ title: "Attention Required! | Cloudflare" })).toContain("challenge_title");
    });
    it("fires on captcha", () => {
      expect(detect({ title: "Please complete the captcha" })).toContain("challenge_title");
    });
    it("fires on CloudFront error page", () => {
      expect(detect({ title: "ERROR: The request could not be satisfied" })).toContain("challenge_title");
    });
    it("fires on 403 forbidden", () => {
      expect(detect({ title: "403 Forbidden" })).toContain("challenge_title");
    });
    it("fires on unusual traffic (Google)", () => {
      expect(detect({ title: "Unusual traffic from your computer network" })).toContain("challenge_title");
    });
    it("fires on 404 not found title", () => {
      expect(detect({ title: "404: not_found" })).toContain("challenge_title");
    });
    it("fires on 'Page not found'", () => {
      expect(detect({ title: "Page Not Found" })).toContain("challenge_title");
    });
    it("fires on 'error 404 - this page does not exist' (workable pattern)", () => {
      expect(detect({ title: "Error 404 - This page does not exist" })).toContain("challenge_title");
    });
    it("fires on 'This page can't be found'", () => {
      expect(detect({ title: "This page can't be found" })).toContain("challenge_title");
    });
    it("fires on 502 bad gateway", () => {
      expect(detect({ title: "Replicate.com | 502: Bad Gateway" })).toContain("challenge_title");
    });
    it("fires on 503 service unavailable", () => {
      expect(detect({ title: "503 Service Unavailable" })).toContain("challenge_title");
    });
    it("fires on generic server error", () => {
      expect(detect({ title: "Internal Server Error" })).toContain("challenge_title");
    });
    it("does NOT fire on normal page titles", () => {
      expect(detect({ title: "Home | Example Corp" })).not.toContain("challenge_title");
    });
  });

  describe("low_capture", () => {
    it("fires when html<500 AND 1-29 apis captured (allmovie pattern)", () => {
      expect(detect({ htmlLength: 141, requestUrls: ["https://ex.com/1"] })).toContain("low_capture");
    });
    it("does NOT fire when html is healthy", () => {
      expect(detect({ htmlLength: 10000, requestUrls: ["https://ex.com/1"] })).not.toContain("low_capture");
    });
    it("does NOT fire when ≥30 apis (no_html_many_apis takes over)", () => {
      const urls = Array.from({ length: 50 }, (_, i) => `https://ex.com/${i}`);
      const signals = detect({ htmlLength: 100, requestUrls: urls });
      expect(signals).not.toContain("low_capture");
      expect(signals).toContain("no_html_many_apis");
    });
  });

  describe("vendor detection", () => {
    it("detects cloudflare via challenge URLs", () => {
      expect(detect({ requestUrls: ["https://challenges.cloudflare.com/turnstile/v0/api.js"] })).toContain("vendor:cloudflare");
    });
    it("detects datadome", () => {
      expect(detect({ requestUrls: ["https://js.datadome.co/tags.js"] })).toContain("vendor:datadome");
    });
    it("detects fastly bot management via _fs-ch- path (e.g. pypi.org)", () => {
      expect(detect({
        requestUrls: ["https://pypi.org/_fs-ch-1T1wmsGaOgGaSxcX/script.js?reload=true"],
      })).toContain("vendor:fastly_bot_management");
    });
    it("detects 'client challenge' title (Fastly)", () => {
      expect(detect({ title: "Client Challenge" })).toContain("challenge_title");
    });
    it("detects first-party PerimeterX via KP_UIDz= param", () => {
      expect(detect({ requestUrls: ["https://www.realtor.com/some/path?KP_UIDz=abc123"] })).toContain("vendor:perimeterx");
    });
    it("detects first-party PerimeterX via UUID/UUID/ips.js path", () => {
      expect(detect({
        requestUrls: ["https://www.example.com/149e9513-01fa-4fb0-aad4-566afd725d1b/2d206a39-8ed7-437e-a3be-862e0f06eea3/ips.js"],
      })).toContain("vendor:perimeterx");
    });
    it("detects imperva via reese84", () => {
      expect(detect({ requestUrls: ["https://www.example.com/reese84/abc"] })).toContain("vendor:imperva_incapsula");
    });
    it("detects Akamai Bot Manager via sensor_data path", () => {
      expect(detect({ requestUrls: ["https://www.walmart.com/akam/11/sensor_data"] })).toContain("vendor:akamai_bot_manager");
    });
    it("detects Akamai Bot Manager via akam.net", () => {
      expect(detect({ requestUrls: ["https://cdn.akam.net/bot-defender.js"] })).toContain("vendor:akamai_bot_manager");
    });
    it("detects reCAPTCHA as captcha_vendor", () => {
      expect(detect({ requestUrls: ["https://www.google.com/recaptcha/api.js"] })).toContain("vendor:captcha_vendor");
    });
    it("emits multiple vendors when multiple hit", () => {
      const signals = detect({
        requestUrls: [
          "https://challenges.cloudflare.com/x",
          "https://js.datadome.co/y",
        ],
      });
      expect(signals).toContain("vendor:cloudflare");
      expect(signals).toContain("vendor:datadome");
    });
  });

  describe("sparse_capture_mostly_noise", () => {
    it("fires when ≤20 requests AND ≥60% rejected as noise", () => {
      expect(detect({
        requestUrls: Array.from({ length: 5 }, (_, i) => `https://ex.com/${i}`),
        rejectionCounts: { not_api_like: 3, score_non_positive: 1 },
      })).toContain("sparse_capture_mostly_noise");
    });
    it("does NOT fire when many requests captured (>20)", () => {
      expect(detect({
        requestUrls: Array.from({ length: 50 }, (_, i) => `https://ex.com/${i}`),
        rejectionCounts: { not_api_like: 30 },
      })).not.toContain("sparse_capture_mostly_noise");
    });
    it("does NOT fire when most requests were real data", () => {
      expect(detect({
        requestUrls: Array.from({ length: 10 }, (_, i) => `https://ex.com/${i}`),
        rejectionCounts: { not_api_like: 1 },
      })).not.toContain("sparse_capture_mostly_noise");
    });
  });

  describe("empty_capture vs no_html_many_apis", () => {
    it("empty_capture fires when no html AND no requests", () => {
      expect(detect({ htmlLength: 0, requestUrls: [] })).toContain("empty_capture");
    });
    it("no_html_many_apis fires when no html but many requests (kuri getPageHtml failed)", () => {
      const urls = Array.from({ length: 100 }, (_, i) => `https://ex.com/${i}`);
      expect(detect({ htmlLength: 0, requestUrls: urls })).toContain("no_html_many_apis");
    });
    it("neither fires when html is present", () => {
      const signals = detect({ htmlLength: 10000, requestUrls: ["https://ex.com/1"] });
      expect(signals).not.toContain("empty_capture");
      expect(signals).not.toContain("no_html_many_apis");
    });
  });
});
