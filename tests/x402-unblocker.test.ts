/**
 * x402-unblocker.test — the paid Cloudflare-class rescue's GATES + fallback chain (the parts
 * testable without spending). The live settle (pay.sh → provider → real content) is proven by
 * integration. Here: paid fallback engages only when a wallet is configured (no manual flag), the
 * chain orders override → known providers, and each provider's body/parse adapter is correct.
 */
import { describe, expect, it } from "bun:test";
import {
  x402PaymentAvailable,
  x402UnblockerChain,
  ONCHAINEXPAT_UNBLOCKER,
  ZERO402_UNBLOCKER,
} from "../src/capture/curl-impersonate-fallback.js";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("x402PaymentAvailable (replaces the old manual flag)", () => {
  it("true when a wallet adapter is set — paid fallback auto-engages, no manual flag", () => {
    expect(x402PaymentAvailable(env({ UNBROWSE_WALLET_ADAPTER: "pay" }))).toBe(true);
    expect(x402PaymentAvailable(env({ UNBROWSE_WALLET_ADAPTER: "lobster" }))).toBe(true);
  });
  it("with adapter 'none' falls back to pay.sh availability (PATH-dependent), never throws", () => {
    // No wallet adapter → the result hinges on whether `pay` is on PATH; either way it's a
    // deterministic boolean and must not throw. (A machine with neither → false → no auto-spend.)
    expect(typeof x402PaymentAvailable(env({ UNBROWSE_WALLET_ADAPTER: "none" }))).toBe("boolean");
  });
});

describe("x402UnblockerChain", () => {
  it("defaults to the known providers in order", () => {
    const chain = x402UnblockerChain(env({}));
    expect(chain.map((e) => e.id)).toEqual(["x402:onchainexpat", "x402:0000402"]);
  });
  it("prepends an override URL (OnchainExpat-shaped) ahead of the providers", () => {
    const chain = x402UnblockerChain(env({ UNBROWSE_X402_UNBLOCKER_URL: "https://my.unblocker/fetch" }));
    expect(chain[0].id).toBe("x402:override");
    expect(chain[0].url).toBe("https://my.unblocker/fetch");
    expect(chain.map((e) => e.id)).toContain("x402:onchainexpat");
  });
});

describe("endpoint adapters", () => {
  it("OnchainExpat: body carries url+country, parse reads .body", () => {
    expect(JSON.parse(ONCHAINEXPAT_UNBLOCKER.body("https://x.com", "US"))).toEqual({ url: "https://x.com", country: "US" });
    expect(ONCHAINEXPAT_UNBLOCKER.parse({ status_code: 200, body: "<html>hi</html>" })).toEqual({ status: 200, html: "<html>hi</html>" });
    expect(ONCHAINEXPAT_UNBLOCKER.parse({ status_code: 200 })).toBeNull();
  });
  it("0000402: parse decodes base64 body when present", () => {
    const b64 = Buffer.from("<html>b64</html>", "utf-8").toString("base64");
    expect(ZERO402_UNBLOCKER.parse({ status: 200, body_base64: b64 })).toEqual({ status: 200, html: "<html>b64</html>" });
    expect(ZERO402_UNBLOCKER.parse({ status: 200, body: "<html>raw</html>" })).toEqual({ status: 200, html: "<html>raw</html>" });
  });
});
