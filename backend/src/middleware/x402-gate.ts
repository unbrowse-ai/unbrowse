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

// 2026-05-26: indexing-mode is the DEFAULT.
//
// Doctrine: unbrowse must work with AND without x402. By default, every
// user-facing route (resolve, search, skill read, execute) runs in
// indexing mode — no payment header required, no 402 emitted. Payment
// is an opt-in feature for operators who explicitly want to charge,
// gated by PAYMENTS_ENABLED=true in the operator's Worker env.
//
// Production wrangler.toml has PAYMENTS_ENABLED="true" explicitly set,
// so prod behavior is unchanged. Self-hosted operators, staging, dev,
// and any environment where the env var is unset get the free-by-default
// indexing path — exactly what the user types `npx unbrowse` for.
//
// Truthy values that explicitly enable payments: "true", "1", "on", "enabled", "yes"
// Anything else (including unset / empty) = indexing mode.
const PAYMENTS_ENABLED_TRUTHY = ["1", "true", "on", "enabled", "yes"];

export function paymentsEnabled(env: Pick<Env, "PAYMENTS_ENABLED">): boolean {
  const raw = env.PAYMENTS_ENABLED?.trim().toLowerCase();
  if (!raw) return false; // default: indexing mode, no x402 ever fires
  return PAYMENTS_ENABLED_TRUTHY.includes(raw);
}

export function searchPaymentsEnabled(
  env: Pick<Env, "PAYMENTS_ENABLED" | "X402_SEARCH_ENABLED">,
): boolean {
  if (!paymentsEnabled(env)) return false;
  const raw = env.X402_SEARCH_ENABLED?.trim().toLowerCase();
  if (!raw) return false; // search payment also opt-in even when global payments enabled
  return PAYMENTS_ENABLED_TRUTHY.includes(raw);
}

export function x402UseTestnet(
  env: Pick<Env, "ENVIRONMENT" | "X402_NETWORK_MODE">,
): boolean {
  const mode = env.X402_NETWORK_MODE?.trim().toLowerCase();
  if (mode === "mainnet") return false;
  if (mode === "testnet") return true;
  return env.ENVIRONMENT !== "production";
}
