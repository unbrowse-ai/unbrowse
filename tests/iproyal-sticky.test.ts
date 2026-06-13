/**
 * iproyal-sticky.test — the sticky-session suffix grammar. IProyal routing params live in the
 * PASSWORD segment (`pass_country-my,sg_session-<id>_lifetime-30m`), not the username; the comma
 * in a multi-country list must stay LITERAL (URL-encoding it to %2C breaks the country list).
 * OFF by default so the egress stays rotating (fresh IP per request) unless explicitly armed.
 */
import { describe, expect, it } from "bun:test";
import { iproyalStickySuffix } from "../src/execution/proxy-fetch.js";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("iproyalStickySuffix", () => {
  it("is empty (rotating) unless explicitly armed", () => {
    expect(iproyalStickySuffix(env({}))).toBe("");
    expect(iproyalStickySuffix(env({ UNBROWSE_IPROYAL_STICKY: "0" }))).toBe("");
    expect(iproyalStickySuffix(env({ UNBROWSE_IPROYAL_STICKY: "" }))).toBe("");
  });

  it("arms on 1/true/yes (case-insensitive)", () => {
    for (const v of ["1", "true", "YES"]) {
      const s = iproyalStickySuffix(env({ UNBROWSE_IPROYAL_STICKY: v, UNBROWSE_IPROYAL_SESSION: "x" }));
      expect(s).toBe("_session-x_lifetime-30m");
    }
  });

  it("keeps a multi-country list literal (no %2C)", () => {
    const s = iproyalStickySuffix(env({
      UNBROWSE_IPROYAL_STICKY: "1",
      UNBROWSE_IPROYAL_COUNTRY: "my,sg",
      UNBROWSE_IPROYAL_SESSION: "abc",
      UNBROWSE_IPROYAL_LIFETIME: "1h",
    }));
    expect(s).toBe("_country-my,sg_session-abc_lifetime-1h");
    expect(s).not.toContain("%2C");
  });

  it("defaults lifetime to 30m and omits country when unset", () => {
    const s = iproyalStickySuffix(env({ UNBROWSE_IPROYAL_STICKY: "1", UNBROWSE_IPROYAL_SESSION: "s1" }));
    expect(s).toBe("_session-s1_lifetime-30m");
    expect(s).not.toContain("_country-");
  });

  it("uses a stable per-process session id when none is given", () => {
    const a = iproyalStickySuffix(env({ UNBROWSE_IPROYAL_STICKY: "1" }));
    const b = iproyalStickySuffix(env({ UNBROWSE_IPROYAL_STICKY: "1" }));
    expect(a).toBe(b); // same process → same sticky IP across the capture→solve→refetch chain
    expect(a).toMatch(/^_session-[0-9a-f]{8}_lifetime-30m$/);
  });
});
