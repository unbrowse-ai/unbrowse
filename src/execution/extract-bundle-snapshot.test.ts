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
    // /init and the collector are not .js, classified as cookie-issuing.
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
    // Vendor signal could fire from challenge_title alone in detector;
    // snapshot should not produce empty payload.
    const r = extractBundleSnapshot({
      requestUrls: ["https://example.com/some-other-thing"],
      blockSignals: ["vendor:datadome"],
      targetOrigin: "https://example.com",
      targetHref: "https://example.com/",
    });
    expect(r).toBeNull();
  });
});
