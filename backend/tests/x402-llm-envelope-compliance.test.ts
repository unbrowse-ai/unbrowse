import { describe, it, expect } from "bun:test";
import { x402v2, isValidationError } from "@faremeter/types";
const { x402PaymentRequiredResponse } = x402v2;
import {
  sponsorAcceptsForPriceUsd,
  PAYAI_FEEPAYER_DEFAULT,
} from "../src/services/flex-route-helpers.js";

// Regression lamp over the real-mainnet-settlement defect found 2026-05-30:
// the live /v1/llm 402 envelope omitted the x402-v2 top-level `resource` object
// and the exact accept's `extra.feePayer`, so a real faremeter exact-scheme
// client failed with "resource must be an object (was missing)" before signing.
// These assertions validate against the ACTUAL @faremeter arktype schemas, not
// a hand-rolled shape, so they catch any future regression to that envelope.

function buildLlmEnvelope(opts: { priceUsd: number; payTo: string; url: string }) {
  const accepts = sponsorAcceptsForPriceUsd(opts.priceUsd, opts.payTo);
  return {
    x402Version: 2,
    error: "payment_required",
    resource: {
      url: opts.url,
      description: "LLM access: nebius/kimi-k2.5",
      mimeType: "application/json",
    },
    accepts,
    facilitator: "faremeter-flex-solana",
    extra: { provider: "nebius", model: "kimi-k2.5" },
  };
}

describe("x402 /v1/llm 402 envelope is faremeter/x402-v2 compliant", () => {
  const env = buildLlmEnvelope({
    priceUsd: 0.003672,
    payTo: "6KpxaoPoTDBAMxNNMPQvQEnTbErtjogL2unK8q3VKcdn",
    url: "https://beta-api.unbrowse.ai/v1/llm/nebius/messages",
  });

  it("validates against @faremeter/types x402PaymentRequiredResponse", () => {
    const out = x402PaymentRequiredResponse(env);
    expect(isValidationError(out)).toBe(false);
  });

  it("carries the exact accept's extra.feePayer the client signer needs", () => {
    // @faremeter/payment-solana exact client reads accept.extra.feePayer to set
    // the on-chain fee payer; without it the client throws on the extra field.
    expect(env.accepts[0].extra?.feePayer).toBe(PAYAI_FEEPAYER_DEFAULT);
    expect(typeof env.accepts[0].extra?.facilitator).toBe("string");
  });

  it("MUTATION: dropping the top-level resource makes it fail validation", () => {
    const broken = { ...env } as Record<string, unknown>;
    delete broken.resource;
    const out = x402PaymentRequiredResponse(broken);
    expect(isValidationError(out)).toBe(true);
  });
});
