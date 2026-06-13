/**
 * x402-unblocker.test — the paid Cloudflare-class rescue rung's GATES (the parts that must hold
 * without spending money). The live settle (pay.sh → OnchainExpat → real content) is proven by
 * integration, not here; here we assert: OFF by default, the enable flag parses correctly, and a
 * disabled rung never spawns `pay` (returns null fast). Negative-cache egress keying for the
 * "x402-unblocker" egress is covered transitively by failure-cache.test.ts.
 */
import { describe, expect, it } from "bun:test";
import {
  x402UnblockerEnabled,
  tryX402UnblockerFetch,
  X402_UNBLOCKER_DEFAULT_URL,
} from "../src/capture/curl-impersonate-fallback.js";

describe("x402UnblockerEnabled", () => {
  it("is OFF unless explicitly armed (it spends real money)", () => {
    expect(x402UnblockerEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(x402UnblockerEnabled({ UNBROWSE_X402_UNBLOCKER: "" } as NodeJS.ProcessEnv)).toBe(false);
    expect(x402UnblockerEnabled({ UNBROWSE_X402_UNBLOCKER: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(x402UnblockerEnabled({ UNBROWSE_X402_UNBLOCKER: "no" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("arms on 1 / true / yes (case-insensitive, trimmed)", () => {
    expect(x402UnblockerEnabled({ UNBROWSE_X402_UNBLOCKER: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(x402UnblockerEnabled({ UNBROWSE_X402_UNBLOCKER: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(x402UnblockerEnabled({ UNBROWSE_X402_UNBLOCKER: " YES " } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("default endpoint", () => {
  it("defaults to the proven Solana-payable OnchainExpat geo unblocker", () => {
    expect(X402_UNBLOCKER_DEFAULT_URL).toContain("onchainexpat.com");
    expect(X402_UNBLOCKER_DEFAULT_URL).toContain("/fetch/geo");
  });
});

describe("tryX402UnblockerFetch gate", () => {
  it("returns null immediately when disabled (never spawns pay)", async () => {
    const prev = process.env.UNBROWSE_X402_UNBLOCKER;
    delete process.env.UNBROWSE_X402_UNBLOCKER;
    const t0 = Date.now();
    const r = await tryX402UnblockerFetch({ url: "https://example.com/" });
    expect(r).toBeNull();
    // disabled path is a pure guard — must not block on a subprocess.
    expect(Date.now() - t0).toBeLessThan(500);
    if (prev !== undefined) process.env.UNBROWSE_X402_UNBLOCKER = prev;
  });
});
