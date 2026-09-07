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
  TWOHUNDREDOK_UNBLOCKER,
} from "../src/capture/curl-impersonate-fallback.js";
import { baseX402Available } from "../src/payments/base-x402-signer.js";

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
  it("always includes the Solana provider; Base providers only when a Base wallet is funded", () => {
    const ids = x402UnblockerChain(env({})).map((e) => e.id);
    expect(ids).toContain("x402:onchainexpat"); // solana rail — always payable via pay.sh
    if (baseX402Available()) {
      expect(ids[0]).toBe("x402:200ok"); // dedicated unblocker first when Base is funded
      expect(ids).toContain("x402:0000402");
    } else {
      expect(ids).not.toContain("x402:200ok"); // can't settle Base → not offered
    }
  });
  it("prepends an override URL ahead of the providers", () => {
    const chain = x402UnblockerChain(env({ UNBROWSE_X402_UNBLOCKER_URL: "https://my.unblocker/fetch" }));
    expect(chain[0].id).toBe("x402:override");
    expect(chain[0].url).toBe("https://my.unblocker/fetch");
  });
  it("tags each provider's settle rail", () => {
    expect(TWOHUNDREDOK_UNBLOCKER.rail).toBe("base");
    expect(ONCHAINEXPAT_UNBLOCKER.rail).toBe("solana");
    expect(ZERO402_UNBLOCKER.rail).toBe("base");
  });
});

describe("endpoint adapters", () => {
  it("OnchainExpat: body carries url+country, parse reads .body", () => {
    expect(JSON.parse(ONCHAINEXPAT_UNBLOCKER.body("https://x.com", "US"))).toEqual({ url: "https://x.com", country: "US" });
    expect(ONCHAINEXPAT_UNBLOCKER.parse({ status_code: 200, body: "<html>hi</html>" })).toEqual({ status: 200, html: "<html>hi</html>" });
    expect(ONCHAINEXPAT_UNBLOCKER.parse({ status_code: 200 })).toBeNull();
  });
  it("200ok: body requests html+js_render, parse reads .html", () => {
    expect(JSON.parse(TWOHUNDREDOK_UNBLOCKER.body("https://x.com", "US"))).toEqual({ url: "https://x.com", type: "html", js_render: true });
    expect(TWOHUNDREDOK_UNBLOCKER.parse({ success: true, html: "<html>ok</html>" })).toEqual({ status: 200, html: "<html>ok</html>" });
    expect(TWOHUNDREDOK_UNBLOCKER.parse({ success: false })).toBeNull();
  });
  it("0000402: parse decodes base64 body when present", () => {
    const b64 = Buffer.from("<html>b64</html>", "utf-8").toString("base64");
    expect(ZERO402_UNBLOCKER.parse({ status: 200, body_base64: b64 })).toEqual({ status: 200, html: "<html>b64</html>" });
    expect(ZERO402_UNBLOCKER.parse({ status: 200, body: "<html>raw</html>" })).toEqual({ status: 200, html: "<html>raw</html>" });
  });
});
