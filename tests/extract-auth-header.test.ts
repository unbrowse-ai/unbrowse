/**
 * extract-auth-header.test — pull an auth header out of a natural-language intent so the
 * one-hole READ path can do a direct authenticated fetch (no capture-ladder timeout).
 */
import { describe, expect, it } from "bun:test";
import { extractAuthHeader } from "../src/lib/extract-auth-header.js";

describe("extractAuthHeader", () => {
  it("extracts a bearer token phrased as 'bearer token <t>'", () => {
    expect(extractAuthHeader("authenticate with bearer token test-token-123 then read the identity"))
      .toBe("Authorization: Bearer test-token-123");
  });
  it("extracts a bearer token phrased as 'bearer <t>'", () => {
    expect(extractAuthHeader("read the feed using bearer sk_live_abc123XYZ"))
      .toBe("Authorization: Bearer sk_live_abc123XYZ");
  });
  it("extracts an API key", () => {
    expect(extractAuthHeader("fetch the data with api key AKIA-9988-zzaa"))
      .toBe("X-API-Key: AKIA-9988-zzaa");
    expect(extractAuthHeader("use x-api-key: sk-77ee-longenough to read"))
      .toBe("X-API-Key: sk-77ee-longenough");
  });
  it("returns undefined for a plain read with no credential", () => {
    expect(extractAuthHeader("what are the top stories")).toBeUndefined();
    expect(extractAuthHeader("read the authenticated identity")).toBeUndefined(); // no token value
    expect(extractAuthHeader("")).toBeUndefined();
  });
  it("does not fire on the word 'token' without a token-shaped value", () => {
    expect(extractAuthHeader("explain how bearer tokens work")).toBeUndefined();
  });
});
