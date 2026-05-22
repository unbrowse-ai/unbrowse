/**
 * User-level credit ledger (D1b, unbrowse-payments-faremeter wave 3).
 *
 * Stripe-driven grants land here, keyed by `user_id` (one per email)
 * rather than `agent_id` (one per API key). A user with multiple keys
 * sees a single shared balance across all of them; debits in the
 * payment-gate path (wave 1/2's `debitKeyFunding`) remain per-key for
 * now because the per-key x402 funding binding is a different concept
 * (user-defined budget per key vs subscription-granted shared pool).
 *
 * KV namespace: `user_credits:<user_id>` (no overlap with the agent-
 * keyed credits.ts namespace, which stays alive for the subsidy pool).
 *
 * Pure-arithmetic logic with single-writer KV access. No Stripe API
 * calls from this file; the webhook handler is the caller that knows
 * which event triggered which grant.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

const USER_CREDITS_PREFIX = "user_credits:";

/**
 * Credit-ledger unit. The $20/mo Pro plan grants 200_000 uc
 * (`PRO_TIER_GRANT_UC` in stripe-tier-detection.ts), so 1 uc = $0.0001 and
 * uc = usd * 10_000. This is the single usd<->uc conversion the credit
 * lane and the auto-refill path share; never re-derive it inline.
 */
export const UC_PER_USD = 10_000;

export interface UserCreditBalance {
  user_id: string;
  /** Cumulative micro-cents granted via Stripe subscription events. */
  granted_uc: number;
  /** Micro-cents earned (e.g. from contributor splits on paid skills). */
  earned_uc: number;
  /** Micro-cents consumed by paid skill executes. */
  consumed_uc: number;
  /** granted + earned - consumed; never negative when consumed. */
  balance_uc: number;
  created_at: string;
  updated_at: string;
}

function key(user_id: string): string {
  return `${USER_CREDITS_PREFIX}${user_id}`;
}

async function readBalance(env: Env, user_id: string): Promise<UserCreditBalance | null> {
  const raw = (await statsKV(env).get(key(user_id))) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserCreditBalance;
  } catch {
    return null;
  }
}

export async function getUserCreditBalance(
  env: Env,
  user_id: string,
): Promise<UserCreditBalance> {
  const existing = await readBalance(env, user_id);
  if (existing) return existing;
  const now = new Date().toISOString();
  return {
    user_id,
    granted_uc: 0,
    earned_uc: 0,
    consumed_uc: 0,
    balance_uc: 0,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Add `amount_uc` to `granted_uc` for this user. Idempotency is the
 * caller's responsibility -- pass a unique source key (e.g. Stripe
 * `${customer.id}:${period_start}`) through `grantStripeTierCredits` to
 * dedupe. This raw primitive ALWAYS adds, so callers must dedupe.
 *
 * Negative amounts are clamped to zero (no claw-back here; that's a
 * separate primitive when we need it).
 */
export async function addUserCredits(
  env: Env,
  user_id: string,
  amount_uc: number,
): Promise<UserCreditBalance> {
  if (!Number.isFinite(amount_uc) || amount_uc <= 0) {
    return getUserCreditBalance(env, user_id);
  }
  const now = new Date().toISOString();
  const existing = (await readBalance(env, user_id)) ?? {
    user_id,
    granted_uc: 0,
    earned_uc: 0,
    consumed_uc: 0,
    balance_uc: 0,
    created_at: now,
    updated_at: now,
  };
  const next: UserCreditBalance = {
    ...existing,
    granted_uc: existing.granted_uc + amount_uc,
    balance_uc: existing.balance_uc + amount_uc,
    updated_at: now,
  };
  await statsKV(env).put(key(user_id), JSON.stringify(next));
  return next;
}

/**
 * Decrement balance by `amount_uc` (consumed). Returns the new balance
 * or null when the user has insufficient funds (balance left untouched).
 * Wave-4 will plumb this into the paid-skill execute path; today this
 * exists for symmetry + future wiring.
 */
export async function debitUserCredits(
  env: Env,
  user_id: string,
  amount_uc: number,
): Promise<{ ok: true; balance: UserCreditBalance } | { ok: false; balance: UserCreditBalance; reason: "insufficient" | "invalid_amount" }> {
  if (!Number.isFinite(amount_uc) || amount_uc <= 0) {
    return { ok: false, balance: await getUserCreditBalance(env, user_id), reason: "invalid_amount" };
  }
  const balance = await getUserCreditBalance(env, user_id);
  if (balance.balance_uc < amount_uc) {
    return { ok: false, balance, reason: "insufficient" };
  }
  const now = new Date().toISOString();
  const next: UserCreditBalance = {
    ...balance,
    consumed_uc: balance.consumed_uc + amount_uc,
    balance_uc: balance.balance_uc - amount_uc,
    updated_at: now,
  };
  await statsKV(env).put(key(user_id), JSON.stringify(next));
  return { ok: true, balance: next };
}
