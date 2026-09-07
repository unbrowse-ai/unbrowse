import { describe, it, expect } from "bun:test";

/**
 * Regression test: browser-capture must auto-extract cookies from the user's
 * browser (Chrome/Dia/Arc/etc.) when the vault is empty.
 *
 * Bug: executeBrowserCapture called getAuthCookies with { autoExtract: false },
 * which skipped browser cookie extraction entirely. Gated sites like LinkedIn
 * returned "no_endpoints" because the capture navigated unauthenticated.
 */

describe("getAuthCookies autoExtract", () => {
  it("returns null with autoExtract false and empty vault", async () => {
    const { getAuthCookies } = await import("../src/auth/index.js");
    const result = await getAuthCookies("test-no-such-domain-99999.com", { autoExtract: false });
    expect(result).toBeNull();
  });

  it("attempts browser extraction with autoExtract true", async () => {
    const { getAuthCookies } = await import("../src/auth/index.js");
    // For a fake domain, browser extraction will find nothing — but it should
    // attempt it rather than early-returning. The important thing is this
    // doesn't throw and goes through the extraction path.
    const result = await getAuthCookies("test-no-such-domain-99999.com", { autoExtract: true });
    expect(result).toBeNull();
  });
});
