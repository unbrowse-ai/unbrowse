import { describe, it, expect } from "bun:test";
import { extractBundleSnapshot } from "./index.js";

describe("extractBundleSnapshot", () => {
  it("returns null when no vendor signal present", () => {
    const r = extractBundleSnapshot({
      requestUrls: ["https://example.com/api/foo"],
      blockSignals: ["empty_capture"],
      targetOrigin: "https://example.com",
      targetHref: "https://example.com/",
    });
    expect(r).toBeNull();
  });

  it("extracts PerimeterX bundle URLs from request stream", () => {
    const r = extractBundleSnapshot({
      requestUrls: [
        "https://www.reddit.com/r/news",
        "https://www.reddit.com/c1234567-89ab-4cde-9012-3456789abcde/c1234567-89ab-4cde-9012-3456789abcde/ips.js",
        "https://www.reddit.com/c1234567-89ab-4cde-9012-3456789abcde/c1234567-89ab-4cde-9012-3456789abcde/init",
        "https://collector-px.perimeterx.net/api/v2/collector",
      ],
      blockSignals: ["vendor:perimeterx", "challenge_title"],
      targetOrigin: "https://www.reddit.com",
      targetHref: "https://www.reddit.com/r/news",
    });
    expect(r).not.toBeNull();
    expect(r!.vendor).toBe("perimeterx");
    expect(r!.bundle_urls).toContain(
      "https://www.reddit.com/c1234567-89ab-4cde-9012-3456789abcde/c1234567-89ab-4cde-9012-3456789abcde/ips.js",
    );
    expect(r!.cookie_issuing_urls.length).toBeGreaterThan(0);
    expect(r!.target_origin).toBe("https://www.reddit.com");
  });

  it("extracts Cloudflare Turnstile bundle URLs", () => {
    const r = extractBundleSnapshot({
      requestUrls: [
        "https://challenges.cloudflare.com/turnstile/v0/api.js",
        "https://example.com/__cf_chl_rt_tk?token=abc",
      ],
      blockSignals: ["vendor:cloudflare"],
      targetOrigin: "https://example.com",
      targetHref: "https://example.com/login",
    });
    expect(r).not.toBeNull();
    expect(r!.vendor).toBe("cloudflare");
    expect(r!.bundle_urls).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
  });

  it("returns null when vendor signal but no matching URLs", () => {
    const r = extractBundleSnapshot({
      requestUrls: ["https://example.com/some-other-thing"],
      blockSignals: ["vendor:datadome"],
      targetOrigin: "https://example.com",
      targetHref: "https://example.com/",
    });
    expect(r).toBeNull();
  });

  // plan-v13 Tier 2B: vendor disambiguation when upstream classifier mislabels
  // an Akamai/Kasada two-UUID-pair bundle as PerimeterX.
  it("classifies two-UUID-pair bundle as akamai_bot_manager when akm_bmfp query param present", () => {
    const r = extractBundleSnapshot({
      requestUrls: [
        "https://www.example.com/c1234567-89ab-4cde-9012-3456789abcde/c1234567-89ab-4cde-9012-3456789abcde/ips.js?akm_bmfp_b2=x",
      ],
      blockSignals: ["vendor:perimeterx"],
      targetOrigin: "https://www.example.com",
      targetHref: "https://www.example.com/",
    });
    expect(r).not.toBeNull();
    expect(r!.vendor).toBe("akamai_bot_manager");
    expect(r!.bundle_urls.length).toBeGreaterThan(0);
  });

  it("classifies two-UUID-pair bundle as kasada when x-kpsdk query param present", () => {
    const r = extractBundleSnapshot({
      requestUrls: [
        "https://www.example.com/c1234567-89ab-4cde-9012-3456789abcde/c1234567-89ab-4cde-9012-3456789abcde/init.js?x-kpsdk-im=y",
      ],
      blockSignals: ["vendor:perimeterx"],
      targetOrigin: "https://www.example.com",
      targetHref: "https://www.example.com/",
    });
    expect(r).not.toBeNull();
    expect(r!.vendor).toBe("kasada");
    expect(r!.bundle_urls.length).toBeGreaterThan(0);
  });

  it("classifies two-UUID-pair bundle as perimeterx when _pxhd cookie present", () => {
    const r = extractBundleSnapshot({
      requestUrls: [
        "https://www.example.com/c1234567-89ab-4cde-9012-3456789abcde/c1234567-89ab-4cde-9012-3456789abcde/init.js",
      ],
      blockSignals: ["vendor:perimeterx"],
      targetOrigin: "https://www.example.com",
      targetHref: "https://www.example.com/",
      cookieNames: ["_pxhd"],
    });
    expect(r).not.toBeNull();
    expect(r!.vendor).toBe("perimeterx");
  });

  it("does not produce a perimeterx false-positive when no disambiguation signal present", () => {
    const r = extractBundleSnapshot({
      requestUrls: [
        "https://www.example.com/c1234567-89ab-4cde-9012-3456789abcde/c1234567-89ab-4cde-9012-3456789abcde/init.js",
      ],
      blockSignals: ["vendor:perimeterx"],
      targetOrigin: "https://www.example.com",
      targetHref: "https://www.example.com/",
    });
    if (r !== null) {
      expect(r.vendor).not.toBe("perimeterx");
    }
  });
});
