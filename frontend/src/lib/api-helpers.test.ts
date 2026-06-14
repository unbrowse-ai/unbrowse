/**
 * Frontend lib units — first unit coverage in frontend/ (TEST-SPECS §12).
 *
 * Pure logic that the UI leans on every render: API-origin resolution
 * (which backend every fetch hits), the registry-card domain humanizer,
 * Runs under `bun test` with no DOM.
 */
import { describe, test, expect } from "bun:test";
import { getConfiguredApiOrigin, getConfiguredApiV1Origin } from "./api-base";
import { humanizeDomain } from "./humanize";

describe("getConfiguredApiOrigin precedence", () => {
  test("NEXT_PUBLIC_API_URL wins over the other env names", () => {
    expect(
      getConfiguredApiOrigin({
        NEXT_PUBLIC_API_URL: "https://one.test",
        NEXT_PUBLIC_API_BASE_URL: "https://two.test",
        UNBROWSE_API_URL: "https://three.test",
      }),
    ).toBe("https://one.test");
  });

  test("falls through NEXT_PUBLIC_API_BASE_URL → UNBROWSE_API_URL → default", () => {
    expect(getConfiguredApiOrigin({ NEXT_PUBLIC_API_BASE_URL: "https://two.test" })).toBe("https://two.test");
    expect(getConfiguredApiOrigin({ UNBROWSE_API_URL: "https://three.test" })).toBe("https://three.test");
    expect(getConfiguredApiOrigin({})).toBe("https://beta-api.unbrowse.ai");
  });

  test("strips trailing slashes and ignores blank values", () => {
    expect(getConfiguredApiOrigin({ NEXT_PUBLIC_API_URL: "https://x.test///" })).toBe("https://x.test");
    expect(getConfiguredApiOrigin({ NEXT_PUBLIC_API_URL: "   " })).toBe("https://beta-api.unbrowse.ai");
  });
});

describe("getConfiguredApiV1Origin", () => {
  test("appends /v1 exactly once", () => {
    expect(getConfiguredApiV1Origin({ NEXT_PUBLIC_API_URL: "https://x.test" })).toBe("https://x.test/v1");
    expect(getConfiguredApiV1Origin({ NEXT_PUBLIC_API_URL: "https://x.test/v1" })).toBe("https://x.test/v1");
  });
});

describe("humanizeDomain (registry card titles)", () => {
  test("strips protocol, www, and path; title-cases the core label", () => {
    expect(humanizeDomain("https://www.stackoverflow.com/questions")).toBe("Stackoverflow");
  });

  test("drops multi-part TLD tails (co.uk style)", () => {
    expect(humanizeDomain("news.bbc.co.uk")).toBe("Bbc");
  });

  test("turns dashes/underscores into spaced Title Case", () => {
    expect(humanizeDomain("flight-tracker.io")).toBe("Flight Tracker");
  });

  test("empty input stays empty; bare label survives", () => {
    expect(humanizeDomain("")).toBe("");
    expect(humanizeDomain("localhost")).toBe("Localhost");
  });
});
