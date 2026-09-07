/**
 * captcha-solve — the x402 captcha-vendor solve path.
 *
 * The d13 backlog note said this was "stubbed"; it is now wired to x402Fetch
 * (the generic 402-signer+retry). This suite verifies the wired logic without a
 * live wallet or a real paysponge call, by mocking x402Fetch:
 *   - 402 from the vendor (no/failed wallet) → no_payment (caller falls back).
 *   - 200 with a solved token → token_received, token extracted + injectable.
 *   - body without a sitekey → no_sitekey (never dispatches / never pays).
 * The live "gated site flips to pass" e2e (real funds + real Turnstile) is a
 * separate, external step.
 */
import { describe, it, expect, mock } from "bun:test";

// Controls the mocked x402Fetch response per-test.
let mockStatus = 402;
let mockJson: unknown = null;

mock.module("../src/payments/x402-fetch.js", () => ({
  x402Fetch: async () => ({
    response: new Response(mockJson != null ? JSON.stringify(mockJson) : null, {
      status: mockStatus,
      headers: { "content-type": "application/json" },
    }),
    trace: {
      sub_state: mockStatus === 402 ? "x402_no_wallet" : "x402_signed",
      adapter: "none",
      error: null,
      requested_cost_usd: 0.01,
    },
  }),
}));

const {
  solveCaptchaViaX402,
  extractSitekey,
  deriveCaptchaSubvendor,
  isCaptchaVendor,
  injectSolvedToken,
} = await import("../src/execution/captcha-solve.js");

const TURNSTILE_BODY = `<html><body><div class="cf-turnstile" data-sitekey="0x4AAAAAAABxyz"></div></body></html>`;

describe("captcha-solve helpers (pure)", () => {
  it("extractSitekey reads data-sitekey", () => {
    expect(extractSitekey(TURNSTILE_BODY)).toBe("0x4AAAAAAABxyz");
    expect(extractSitekey("<div>no captcha here</div>")).toBeNull();
  });

  it("deriveCaptchaSubvendor sniffs the widget", () => {
    expect(deriveCaptchaSubvendor(`<div class="g-recaptcha"></div>`)).toBe("recaptcha");
    expect(deriveCaptchaSubvendor(`<div class="h-captcha"></div>`)).toBe("hcaptcha");
  });

  it("isCaptchaVendor gates the solvable set", () => {
    expect(isCaptchaVendor("cloudflare")).toBe(true);
    expect(isCaptchaVendor("datadome")).toBe(false);
    expect(isCaptchaVendor(undefined)).toBe(false);
  });

  it("injectSolvedToken adds header + bare key, no-op on empty token", () => {
    const injected = injectSolvedToken({ a: "1" }, { token: "TOK", inject_key: "cf-turnstile-response", cost_usd: 0.01, evidence: {} });
    expect(injected["cf-turnstile-response"]).toBe("TOK");
    expect(injected["x-cf-turnstile-response"]).toBe("TOK");
    expect(injectSolvedToken({ a: "1" }, { token: "", inject_key: "k", cost_usd: 0, evidence: {} })).toEqual({ a: "1" });
  });
});

describe("solveCaptchaViaX402 (x402 wired)", () => {
  it("no sitekey → no_sitekey, never dispatches", async () => {
    const r = await solveCaptchaViaX402({ vendor: "cloudflare", body: "<div>nothing</div>", challengeUrl: "https://x.test/" });
    expect(r?.token).toBe("");
    expect((r?.evidence as { sub_state?: string }).sub_state).toBe("no_sitekey");
  });

  it("vendor returns 402 (no wallet) → no_payment, token empty", async () => {
    mockStatus = 402; mockJson = null;
    const r = await solveCaptchaViaX402({ vendor: "cloudflare", body: TURNSTILE_BODY, challengeUrl: "https://x.test/" });
    expect(r?.token).toBe("");
    expect((r?.evidence as { sub_state?: string }).sub_state).toBe("no_payment");
    expect((r?.evidence as { status?: number }).status).toBe(402);
  });

  it("vendor returns a solved token → token_received", async () => {
    mockStatus = 200; mockJson = { solution: { token: "SOLVED_TOKEN_123" } };
    const r = await solveCaptchaViaX402({ vendor: "cloudflare", body: TURNSTILE_BODY, challengeUrl: "https://x.test/" });
    expect(r?.token).toBe("SOLVED_TOKEN_123");
    expect(r?.cost_usd).toBeGreaterThan(0);
    expect((r?.evidence as { sub_state?: string }).sub_state).toBe("token_received");
  });

  it("vendor returns errorId → solver_error", async () => {
    mockStatus = 200; mockJson = { errorId: 1, errorDescription: "ERROR_KEY_DOES_NOT_EXIST" };
    const r = await solveCaptchaViaX402({ vendor: "cloudflare", body: TURNSTILE_BODY, challengeUrl: "https://x.test/" });
    expect(r?.token).toBe("");
    expect((r?.evidence as { sub_state?: string }).sub_state).toBe("solver_error");
  });
});
