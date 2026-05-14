/**
 * x402 payment gating middleware — kill-switches + shared types for the Flex
 * facilitator path.
 *
 * The legacy Corbits facilitator codepath (verify/settle/supported probes,
 * PAYMENT-SIGNATURE / X-Payment-Proof envelopes, the `exact`-scheme dual-chain
 * accepts[] builder) was removed in v6.16 Phase 5 (Day-6, Genesis Dominion).
 * All paid routes — skills, demos, search — now go through
 * `services/flex-route-helpers.ts` (`respondWithFlexTerms` /
 * `handleFlexPaymentAuthorized`) backed by the Flex facilitator.
 *
 * What remains here:
 *   - `paymentsEnabled` / `searchPaymentsEnabled` — env-var kill-switches the
 *     routes still consult before pricing/charging.
 *   - `x402UseTestnet` — generic mainnet/testnet selector used by Flex routes.
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

export function paymentsEnabled(env: Pick<Env, "PAYMENTS_ENABLED">): boolean {
  const raw = env.PAYMENTS_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "disabled", "no"].includes(raw);
}

export function searchPaymentsEnabled(
  env: Pick<Env, "PAYMENTS_ENABLED" | "X402_SEARCH_ENABLED">,
): boolean {
  if (!paymentsEnabled(env)) return false;
  const raw = env.X402_SEARCH_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "disabled", "no"].includes(raw);
}

export function x402UseTestnet(
  env: Pick<Env, "ENVIRONMENT" | "X402_NETWORK_MODE">,
): boolean {
  const mode = env.X402_NETWORK_MODE?.trim().toLowerCase();
  if (mode === "mainnet") return false;
  if (mode === "testnet") return true;
  return env.ENVIRONMENT !== "production";
}
