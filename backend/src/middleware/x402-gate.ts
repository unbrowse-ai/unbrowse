/**
 * x402 payment gating middleware — shared types for the Flex facilitator path.
 *
 * The legacy Corbits facilitator codepath (verify/settle/supported probes,
 * PAYMENT-SIGNATURE / X-Payment-Proof envelopes, the `exact`-scheme dual-chain
 * accepts[] builder) was removed in v6.16 Phase 5 (Day-6, Genesis Dominion).
 * All paid routes — skills, demos, search — now go through
 * `services/flex-route-helpers.ts` (`respondWithFlexTerms` /
 * `handleFlexPaymentAuthorized`) backed by the Flex facilitator.
 *
 * 2026-05-26 — env-var escape hatches REMOVED. The user directive: "shouldn't
 * have envs that could break — no escape hatches". The old `paymentsEnabled` /
 * `searchPaymentsEnabled` functions read `PAYMENTS_ENABLED` and
 * `X402_SEARCH_ENABLED` from `c.env`. Any stale wrangler.toml entry could
 * accidentally flip the substrate between paid and free modes. That is a
 * footgun.
 *
 * Replacement doctrine (composes with PR #810):
 *   - Indexing is always free. Every user-facing route runs the free path
 *     unless the skill manifest declares `owner_compensation_opt_in = true`
 *     via DNS claim + wallet binding.
 *   - The ONLY lever is per-skill. There is no operator-level env-var that
 *     can be set / unset / typo'd to change the substrate's behavior.
 *   - `priceResult.price_usd > 0` (from `services/pricing.ts`) IS the gate.
 *     If price is zero (default), the route returns 200 free. If price is
 *     nonzero (owner explicitly opted in), the route emits a 402 Flex envelope.
 *
 * What remains here:
 *   - `x402UseTestnet` — generic mainnet/testnet selector used by Flex routes
 *     when building accepts[] entries. NOT a payment gate; selects which
 *     network the on-wire `accepts[].network` field references. Default is
 *     mainnet in production, testnet elsewhere — derived from
 *     `ENVIRONMENT`, not from a payments toggle.
 *   - `X402PaymentRequirementV2` — on-the-wire accepts[] entry shape consumed
 *     by the sponsor middleware and Flex helpers.
 */

import type { Env } from "../types.js";

export interface X402PaymentRequirementV2 {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export function x402UseTestnet(
  env: Pick<Env, "ENVIRONMENT" | "X402_NETWORK_MODE">,
): boolean {
  const mode = env.X402_NETWORK_MODE?.trim().toLowerCase();
  if (mode === "mainnet") return false;
  if (mode === "testnet") return true;
  return env.ENVIRONMENT !== "production";
}
