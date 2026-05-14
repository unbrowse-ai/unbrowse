/**
 * Sponsor middleware — platform-funded first calls for new agents.
 *
 * Day 3 (Genesis Land): seed only. The three pure env-helpers are real; the
 * decision function `maybeSponsor` is a stub that throws so the wiring is
 * visible but no USDC moves. Day 4 fills in the cap-check + ledger-row +
 * sendSponsorPayment call.
 *
 * Contract:
 * - Resolves a SponsorDecision describing what the gate did (paid, exhausted,
 *   opted-out). The caller decides whether to short-circuit the 402 or fall
 *   through to the standard x402 ladder.
 * - Never throws on "sponsor refused-to-enable" — that's a normal exhausted
 *   outcome. Only throws on real programming errors (today: the stub itself).
 */

import type { Context } from "hono";
import type { Env } from "../types.js";
import type { X402PaymentRequirementV2 } from "./x402-gate.js";

export type SponsorDecision =
  | {
      kind: "sponsored";
      tx_hash: string;
      amount_usdc: string;
      remaining_credit_usd: number;
      ledger_id: string;
    }
  | {
      kind: "exhausted";
      reason: "agent_cap" | "global_cap" | "no_wallet";
      remaining_credit_usd: number;
    }
  | { kind: "opted_out" };

/**
 * Narrow env shape for the pure helpers. Kept separate from the full Env so
 * unit tests can pass synthetic objects without filling 60+ fields.
 */
export interface SponsorEnv {
  PLATFORM_SPONSOR_WALLET_ADDRESS?: string;
  PLATFORM_SPONSOR_WALLET_KEY?: string;
  SPONSOR_CAP_DAILY_USD?: string;
  SPONSOR_GLOBAL_DAILY_USD?: string;
}

/** True iff both the public address and the signer key are present. */
export function sponsorWalletReady(env: SponsorEnv): boolean {
  const addr = env.PLATFORM_SPONSOR_WALLET_ADDRESS?.trim();
  const key = env.PLATFORM_SPONSOR_WALLET_KEY?.trim();
  return Boolean(addr && key);
}

/** Per-agent daily cap in USD. Defaults to $1.00 when env var is unset/invalid. */
export function sponsorCapDailyUsd(env: SponsorEnv): number {
  const raw = env.SPONSOR_CAP_DAILY_USD?.trim();
  if (!raw) return 1.0;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1.0;
}

/** Org-wide daily cap in USD. Defaults to $50.00 when env var is unset/invalid. */
export function sponsorGlobalCapDailyUsd(env: SponsorEnv): number {
  const raw = env.SPONSOR_GLOBAL_DAILY_USD?.trim();
  if (!raw) return 50.0;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 50.0;
}

/**
 * Decide whether to sponsor this call.
 *
 * Day 3 seed: throws "not yet implemented (Day 4)". The signature is locked
 * so route wiring on Day 4 just needs to import + await — no caller changes.
 *
 * Day 4 contract (to be implemented):
 *   1. If !sponsorWalletReady(env) → { kind: "exhausted", reason: "no_wallet", remaining_credit_usd: 0 }
 *   2. Read per-agent + global daily spend from STATS_KV; compare to caps.
 *   3. If under both caps and paymentTerms picks a USDC term, call
 *      sendSponsorPayment(env, paymentTerms[i].payTo, amountUc).
 *   4. On success, write a ledger row and return { kind: "sponsored", ... }.
 *   5. On cap-exceeded or transfer failure, return { kind: "exhausted", ... }.
 */
export async function maybeSponsor(
  c: Context<{ Bindings: Env }>,
  paymentTerms: X402PaymentRequirementV2[],
  agentId: string,
): Promise<SponsorDecision> {
  void c;
  void paymentTerms;
  void agentId;
  throw new Error("not yet implemented (Day 4)");
}
