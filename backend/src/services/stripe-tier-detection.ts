/**
 * L3 (partial) Stripe three-tier detection (unbrowse-payments-faremeter).
 *
 * Pure-function primitive: given a Stripe subscription event payload and
 * the env-configured price IDs for the three tiers (Free / Pro / Metered),
 * return the inferred tier and the per-tier credit grant the wave-3
 * billing handler should apply.
 *
 * Why split this out from `processBillingEvent`:
 *   1. Tier inference is data-only -- no IO, no DB. Pure function, easy
 *      to test, easy to reason about.
 *   2. The user-to-agent mapping decision (which keyId receives the
 *      grant when the user has multiple keys) is a separate concern and
 *      lives in wave 3. By isolating tier detection here we keep the
 *      wave-2 deliverable a single committable primitive without forcing
 *      that decision now.
 *   3. The Stripe event shape is stable; pinning the parse here gives us
 *      a single place to upgrade when Stripe-versioned event payloads
 *      change.
 *
 * Tiers:
 *   - free:    no subscription, or subscription cancelled. 0 uc grant.
 *   - pro:     flat $20/mo subscription with STRIPE_PRICE_PRO_MONTHLY.
 *              200_000 uc grant per period rollover.
 *   - metered: STRIPE_PRICE_METERED on the subscription. Granted credits
 *              are 0 (metered billing fires per execute via Meter API in
 *              wave 3); we surface tier=metered so the execute handler
 *              knows which path to take.
 */

export type StripeTier = "free" | "pro" | "metered";

/** Subset of Stripe.Subscription we read. Reduces tsc dep on the SDK type. */
export interface StripeSubscriptionLike {
  status?: string | null;
  items?: {
    data?: Array<{
      price?: {
        id?: string | null;
      } | null;
    }>;
  } | null;
}

export interface StripeTierInference {
  tier: StripeTier;
  /** Micro-cents to grant on this event (0 for free + metered + no-op). */
  grant_uc: number;
  /** Pro price id that matched, or null for free/metered/no-match. */
  matched_price_id: string | null;
  /** Stripe subscription status; useful for the caller to short-circuit cancellation. */
  status: string | null;
}

const PRO_TIER_GRANT_UC = 200_000;

interface PriceConfig {
  STRIPE_PRICE_PRO_MONTHLY?: string;
  STRIPE_PRICE_METERED?: string;
}

/**
 * Infer the tier + grant amount for a subscription event.
 *
 * Idempotency: a single grant of grant_uc per inference. The caller MUST
 * dedupe by stripe event_id (or similar) so multiple webhook retries for
 * the same event don't multi-grant. This function doesn't enforce that;
 * it's a pure inference.
 *
 * Status semantics:
 *   - active / trialing -> tier inferred from price; positive grant if Pro
 *   - past_due / unpaid / incomplete / paused -> tier inferred but grant = 0
 *     (the wave-3 caller can decide to claw back or hold)
 *   - canceled / incomplete_expired -> tier = "free", grant = 0
 *
 * Multiple prices on one subscription (Pro + Metered as combo): if BOTH
 * are present, prefer "metered" since the Metered ceiling subsumes Pro's
 * flat grant. The 200k Pro grant only fires on a Pro-only subscription.
 */
export function inferTier(
  env: PriceConfig,
  subscription: StripeSubscriptionLike | null | undefined,
): StripeTierInference {
  if (!subscription) {
    return { tier: "free", grant_uc: 0, matched_price_id: null, status: null };
  }
  const status = subscription.status?.trim() || null;
  if (status === "canceled" || status === "incomplete_expired") {
    return { tier: "free", grant_uc: 0, matched_price_id: null, status };
  }

  const priceIds = (subscription.items?.data ?? [])
    .map((item) => item.price?.id?.trim())
    .filter((id): id is string => !!id);

  const proPrice = env.STRIPE_PRICE_PRO_MONTHLY?.trim();
  const meteredPrice = env.STRIPE_PRICE_METERED?.trim();

  const hasMetered = !!meteredPrice && priceIds.includes(meteredPrice);
  const hasPro = !!proPrice && priceIds.includes(proPrice);

  // Metered subsumes Pro: a customer on both gets metered semantics.
  if (hasMetered) {
    return {
      tier: "metered",
      grant_uc: 0, // metered fires per-execute via Meter API, not on grant
      matched_price_id: meteredPrice,
      status,
    };
  }
  if (hasPro) {
    const isHealthy = status === "active" || status === "trialing";
    return {
      tier: "pro",
      grant_uc: isHealthy ? PRO_TIER_GRANT_UC : 0,
      matched_price_id: proPrice,
      status,
    };
  }
  // Subscription exists, but no recognized price -> treat as free.
  return { tier: "free", grant_uc: 0, matched_price_id: null, status };
}

export const TIER_GRANTS = {
  PRO_TIER_GRANT_UC,
};
