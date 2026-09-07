import { describe, expect, it } from "bun:test";
import { captureRecoveryPlan, classifyCaptureBlocker, filterFirstPartySessionCookies } from "../src/capture/index.js";

describe("capture blocker classification", () => {
  it("keeps WAF, auth, and empty-capture failures distinct", () => {
    expect(classifyCaptureBlocker({ html: "<title>Just a moment...</title> Cloudflare", requestCount: 1, responseBodyCount: 1 })).toBe("cloudflare");
    expect(classifyCaptureBlocker({ html: '<main id="LoggedOutShell">Log in to X</main>', requestCount: 1, responseBodyCount: 1 })).toBe("auth_required");
  expect(classifyCaptureBlocker({ html: "", requestCount: 0, responseBodyCount: 0 })).toBe("empty_capture");
  expect(captureRecoveryPlan("cloudflare", { chromium_available: true, chromium_cdp_available: true }, 120_000))
    .toEqual({ blocker: "cloudflare", retryable: false, max_attempts: 0, deadline_ms: 75_000 });
  expect(captureRecoveryPlan("empty_capture", { chromium_available: true, chromium_cdp_available: true }, 5_000))
    .toMatchObject({ blocker: "empty_capture", retryable: true, max_attempts: 1, deadline_ms: 5_000 });
  });
});

describe("filterFirstPartySessionCookies", () => {
  it("drops third-party adtech cookies from captured sessions", () => {
    const filtered = filterFirstPartySessionCookies([
      { name: "epi", value: "1", domain: ".epicurious.com" },
      { name: "www", value: "1", domain: "www.epicurious.com" },
      { name: "ads", value: "1", domain: ".doubleclick.net" },
      { name: "sync", value: "1", domain: ".criteo.com" },
    ], "https://www.epicurious.com/search?q=lasagna");

    expect(filtered).toEqual([
      { name: "epi", value: "1", domain: ".epicurious.com" },
      { name: "www", value: "1", domain: "www.epicurious.com" },
    ]);
  });

  it("keeps registrable-domain cookies for ccTLD hosts", () => {
    const filtered = filterFirstPartySessionCookies([
      { name: "shop", value: "1", domain: ".example.co.uk" },
      { name: "api", value: "1", domain: "api.example.co.uk" },
      { name: "tracker", value: "1", domain: ".example.com" },
    ], "https://api.example.co.uk/search?q=tea");

    expect(filtered).toEqual([
      { name: "shop", value: "1", domain: ".example.co.uk" },
      { name: "api", value: "1", domain: "api.example.co.uk" },
    ]);
  });
});
