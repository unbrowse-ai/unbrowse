/**
 * Monthly-USDC subscription service (ported from aiko-v2's crypto-sub.ts
 * under contract organ 1682152a stage B). Buys 30 days of access with a
 * one-shot x402 USDC payment instead of a Stripe card-on-file.
 *
 * The KV layout is the canonical unbrowse Stripe-sub-cache shape from
 * `stripe.types.ts` — read-side gating (`readSubFromKV`, `GET /v1/billing/me`,
 * sponsor middleware ladder) sees a crypto sub the same way it sees a
 * Stripe sub:
 *
 *   stripe:user:<user_id>                   → "crypto-<user_id>"     (1y TTL)
 *   stripe:customer:crypto-<user_id>        → STRIPE_SUB_CACHE JSON  (90d TTL)
 *
 * The `customerId` prefix `crypto-` is the discriminator the read side
 * can grep on if it needs to distinguish payment method. The
 * `paymentMethod` field on the cache row is `null` for crypto subs (the
 * STRIPE_SUB_CACHE type's brand/last4 carries no semantic for USDC).
 *
 * **Firmament invariant** (carried verbatim from aiko-v2): a user cannot
 * hold an active Stripe sub AND an active crypto sub at the same time.
 * `assertNoStripeConflict` enforces it; both POST handlers and the intent
 * activator call it.
 *
 * Per CLAUDE.md "no project re-implements unbrowse-canonical payment
 * logic" (organ 1682152a stage D): this module IS the canonical surface
 * for monthly-USDC subscriptions. Aiko's `aiko-api-worker/src/crypto-sub.ts`
 * is now a fossil; aiko's frontend talks to `/v1/billing/crypto-sub/*`.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import { KV_KEYS } from "./stripe.js";
import type { STRIPE_SUB_CACHE } from "./stripe.types.js";

// ─── Time constants (seconds; matches aiko-v2's choices) ──────────────────

export const THIRTY_DAYS_SECONDS = 60 * 60 * 24 * 30;
export const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
export const NINETY_DAYS_SECONDS = 60 * 60 * 24 * 90;
export const INTENT_TTL_SECONDS = 60 * 10;
export const PAID_INTENT_TTL_SECONDS = 60 * 60 * 24;

// ─── Tiers ────────────────────────────────────────────────────────────────

export type CryptoSubPlan = "base" | "pro";

/** USD amount for a plan, env-driven (CRYPTO_BASE_USDC / CRYPTO_PRO_USDC). */
export function amountForPlan(env: Env, plan: CryptoSubPlan): string {
  const base = env.CRYPTO_BASE_USDC?.trim() || "19";
  const pro = env.CRYPTO_PRO_USDC?.trim() || "59";
  return plan === "pro" ? pro : base;
}

/** Stripe price ID for the plan — used as the priceId in the cache row so
 *  read-side quota lookups see the same identifier as a Stripe sub. */
export function priceIdForPlan(env: Env, plan: CryptoSubPlan): string | undefined {
  return plan === "pro" ? env.STRIPE_PRICE_PRO_MONTHLY : env.STRIPE_PRICE_BASE;
}

/** Default monthly quota when the env doesn't pin one — generous so
 *  agents don't get throttled on a fresh sub. Override via env. */
function quotaForPlan(env: Env, plan: CryptoSubPlan): number {
  const fromEnv = plan === "pro" ? env.CRYPTO_PRO_QUOTA : env.CRYPTO_BASE_QUOTA;
  const parsed = fromEnv ? Number(fromEnv) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed);
  return plan === "pro" ? 1_000_000 : 200_000; // µ¢ / "calls" — read-side decides
}

// ─── KV helpers — mirror the sponsor-pool pattern (statsKV first,
// raw STATS_KV fallback so unit tests can drive in-memory KV) ─────────────

async function kvGet(env: Env, key: string): Promise<string | null> {
  return (await statsKV(env).get(key)) as string | null;
}

async function kvPut(
  env: Env,
  key: string,
  value: string,
  options?: { expirationTtl?: number },
): Promise<void> {
  if (options?.expirationTtl != null) {
    await statsKV(env).put(key, value, options);
  } else {
    await statsKV(env).put(key, value);
  }
}

// ─── Intent model — short-lived JSON row keyed by intent id ───────────────

export type CryptoSubIntentStatus = "pending" | "paid";

export interface CryptoSubIntent {
  id: string;
  userId: string;
  /** Always "crypto-<userId>" — the customerId prefix discriminator. */
  customerId: string;
  plan: CryptoSubPlan;
  status: CryptoSubIntentStatus;
  priceId: string;
  amount: string;
  currency: "USDC";
  network: string;
  createdAt: number;
  expiresAt: number;
  currentPeriodEnd?: number;
}

function intentKey(intentId: string): string {
  return `crypto:intent:${intentId}`;
}

export async function loadIntent(
  env: Env,
  intentId: string,
): Promise<CryptoSubIntent | null> {
  const raw = await kvGet(env, intentKey(intentId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CryptoSubIntent;
  } catch {
    return null;
  }
}

export async function saveIntent(
  env: Env,
  intent: CryptoSubIntent,
  options: { ttlSeconds: number },
): Promise<void> {
  await kvPut(env, intentKey(intent.id), JSON.stringify(intent), {
    expirationTtl: options.ttlSeconds,
  });
}

// ─── Conflict detection — firmament invariant ─────────────────────────────

export type CryptoSubConflict =
  | { kind: "stripe_sub_active"; message: string }
  | { kind: "crypto_sub_active"; message: string };

/**
 * Returns a conflict descriptor when the user already has an active or
 * trialing Stripe / crypto sub; null when the field is free to claim.
 */
export async function assertNoStripeConflict(
  env: Env,
  userId: string,
): Promise<CryptoSubConflict | null> {
  const existingCustomerId = await kvGet(env, KV_KEYS.userCustomer(userId));
  if (!existingCustomerId) return null;
  const existingRaw = await kvGet(env, KV_KEYS.customerSub(existingCustomerId));
  if (!existingRaw) return null;
  let parsed: { status?: string };
  try {
    parsed = JSON.parse(existingRaw) as { status?: string };
  } catch {
    return null;
  }
  if (parsed.status !== "active" && parsed.status !== "trialing") return null;
  if (existingCustomerId.startsWith("crypto-")) {
    return {
      kind: "crypto_sub_active",
      message: "An active USDC subscription already exists; wait for it to expire before re-subscribing.",
    };
  }
  return {
    kind: "stripe_sub_active",
    message: "Cancel your Stripe subscription before paying with USDC.",
  };
}

// ─── Activation — write the canonical STRIPE_SUB_CACHE row ────────────────

export interface CryptoSubActivationResult {
  customerId: string;
  cache: STRIPE_SUB_CACHE & { status: "active" };
}

/**
 * Marks the user as having an active crypto-subscription. Idempotent on
 * the (userId, plan) pair within a 30-day window — re-running just
 * refreshes the cache row with a new period end.
 */
export async function activateCryptoSubscription(
  env: Env,
  args: {
    userId: string;
    plan: CryptoSubPlan;
    /** Stripe price id — used for read-side tier detection. */
    priceId: string;
  },
): Promise<CryptoSubActivationResult> {
  const now = Math.floor(Date.now() / 1000);
  const customerId = `crypto-${args.userId}`;
  const cache: STRIPE_SUB_CACHE & { status: "active" } = {
    status: "active",
    subscriptionId: `crypto_${crypto.randomUUID()}`,
    priceId: args.priceId,
    currentPeriodStart: now,
    currentPeriodEnd: now + THIRTY_DAYS_SECONDS,
    cancelAtPeriodEnd: false,
    paymentMethod: null,
    quota: quotaForPlan(env, args.plan),
    overageAllowed: false,
    overagePriceId: null,
    updatedAt: now,
  };
  await kvPut(env, KV_KEYS.userCustomer(args.userId), customerId, {
    expirationTtl: ONE_YEAR_SECONDS,
  });
  await kvPut(env, KV_KEYS.customerSub(customerId), JSON.stringify(cache), {
    expirationTtl: NINETY_DAYS_SECONDS,
  });
  // Reverse index so a future crypto-side webhook can resolve customer.id → user_id
  // (mirrors the Stripe path's reverse-index write at stripe.ts:201).
  await kvPut(env, KV_KEYS.customerUser(customerId), args.userId, {
    expirationTtl: ONE_YEAR_SECONDS,
  });
  return { customerId, cache };
}

// ─── Quote shape (read-only) ──────────────────────────────────────────────

export interface CryptoSubQuote {
  plan: CryptoSubPlan;
  amount: string;
  currency: "USDC";
  network: string;
  protocol: "x402";
  memo: string;
  /** Quoted period length in seconds (30 days). */
  periodSeconds: number;
}

export function quoteForPlan(env: Env, plan: CryptoSubPlan): CryptoSubQuote {
  return {
    plan,
    amount: amountForPlan(env, plan),
    currency: "USDC",
    network: env.X402_NETWORK_MODE?.trim() || "solana-mainnet",
    protocol: "x402",
    memo: `Unbrowse ${plan === "pro" ? "Pro" : "Base"} subscription — 30 days`,
    periodSeconds: THIRTY_DAYS_SECONDS,
  };
}

// ─── Intent factory ───────────────────────────────────────────────────────

export function newCryptoSubIntent(
  env: Env,
  args: { userId: string; plan: CryptoSubPlan; priceId: string },
): CryptoSubIntent {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: crypto.randomUUID(),
    userId: args.userId,
    customerId: `crypto-${args.userId}`,
    plan: args.plan,
    status: "pending",
    priceId: args.priceId,
    amount: amountForPlan(env, args.plan),
    currency: "USDC",
    network: env.X402_NETWORK_MODE?.trim() || "solana-mainnet",
    createdAt: now,
    expiresAt: now + INTENT_TTL_SECONDS,
  };
}

// ─── Plan parsing ─────────────────────────────────────────────────────────

export function planFromParam(value: string | undefined): CryptoSubPlan | null {
  return value === "base" || value === "pro" ? value : null;
}
