/**
 * iproyal-sticky.test — the sticky-session suffix grammar. IProyal routing params live in the
 * PASSWORD segment (`pass_country-my,sg_session-<id>_lifetime-30m`), not the username; the comma
 * in a multi-country list must stay LITERAL (URL-encoding it to %2C breaks the country list).
 * ON BY DEFAULT (stable IP per process = human-like + IP-bound-cookie survival); opt OUT with =0.
 */
import { describe, expect, it } from "bun:test";
import { iproyalStickySuffix } from "../src/execution/proxy-fetch.js";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("iproyalStickySuffix", () => {
  it("is ON by default (stable session, 30m), no env needed", () => {
    const s = iproyalStickySuffix(env({}));
    expect(s).toMatch(/^_session-[0-9a-f]{8}_lifetime-30m$/);
  });

  it("opts OUT to rotating with =0 / false / no", () => {
    expect(iproyalStickySuffix(env({ UNBROWSE_IPROYAL_STICKY: "0" }))).toBe("");
    expect(iproyalStickySuffix(env({ UNBROWSE_IPROYAL_STICKY: "false" }))).toBe("");
    expect(iproyalStickySuffix(env({ UNBROWSE_IPROYAL_STICKY: "no" }))).toBe("");
  });

  it("keeps a multi-country list literal (no %2C)", () => {
    const s = iproyalStickySuffix(env({
      UNBROWSE_IPROYAL_COUNTRY: "my,sg",
      UNBROWSE_IPROYAL_SESSION: "abc",
      UNBROWSE_IPROYAL_LIFETIME: "1h",
    }));
    expect(s).toBe("_country-my,sg_session-abc_lifetime-1h");
    expect(s).not.toContain("%2C");
  });

  it("omits country when unset, defaults lifetime to 30m", () => {
    const s = iproyalStickySuffix(env({ UNBROWSE_IPROYAL_SESSION: "s1" }));
    expect(s).toBe("_session-s1_lifetime-30m");
    expect(s).not.toContain("_country-");
  });

  it("uses a stable per-process session id when none is given", () => {
    const a = iproyalStickySuffix(env({}));
    const b = iproyalStickySuffix(env({}));
    expect(a).toBe(b); // same process → same sticky IP across the capture→solve→refetch chain
  });
});
