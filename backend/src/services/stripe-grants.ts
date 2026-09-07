/**
 * Stripe -> credit-grant dispatcher (D3b idempotency, wave 3 of
 * unbrowse-payments-faremeter).
 *
 * Reads a Stripe subscription event, infers the tier via the wave-2
 * `inferTier` primitive, resolves the customer back to its unbrowse
 * user_id via the reverse index, and adds the inferred grant_uc to that
 * user's credit balance -- ONCE per customer per billing period. Stripe
 * re-delivers webhooks; the idempotency key
 * `${customer.id}:${period_start}` ensures the same period grants only
 * once even when `customer.subscription.updated` and `invoice.paid`
 * both fire for the same period.
 *
 * Failure modes (each returns a typed reason so the caller logs cleanly):
 *  - no_customer_user_mapping: the customer.id is not in our reverse
 *    index. Either the customer was created before wave-3 deployed, or
 *    the webhook arrived before getOrCreateCustomer ran for that user.
 *    The caller should NOT guess; surface and move on.
 *  - duplicate: idempotency key was already used; this is the expected
 *    happy path on webhook redelivery.
 *  - tier_no_grant: tier inferred to be free / metered / past_due /
 *    paused / status-null. No grant fires; this is correct.
 *  - applied: grant landed; new balance returned.
 *
 * This module never throws -- it returns the reason. Webhook handlers
 * are noisy and shouldn't surface errors that retry the whole event for
 * a non-actionable cause.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import { inferTier, type StripeSubscriptionLike } from "./stripe-tier-detection.js";
import { lookupUserIdByCustomerId } from "./stripe.js";
import { addUserCredits, type UserCreditBalance } from "./user-credits.js";

const IDEM_PREFIX = "stripe_grant_idem:";

export type GrantOutcome =
  | { kind: "applied"; user_id: string; amount_uc: number; balance: UserCreditBalance; idem_key: string }
  | { kind: "duplicate"; idem_key: string }
  | { kind: "no_customer_user_mapping"; customer_id: string }
  | { kind: "tier_no_grant"; tier: string; reason: string };

export interface StripeSubscriptionEventLike {
  type?: string;
  data?: {
    object?: StripeSubscriptionLike & {
      id?: string;
      customer?: string | { id?: string } | null;
      current_period_start?: number | null;
      items?: StripeSubscriptionLike["items"];
    };
  };
}

function customerIdOf(evt: StripeSubscriptionEventLike): string | null {
  const c = evt.data?.object?.customer;
  if (typeof c === "string" && c.length > 0) return c;
  if (c && typeof c === "object" && typeof c.id === "string" && c.id.length > 0) {
    return c.id;
  }
  return null;
}

function periodStartOf(evt: StripeSubscriptionEventLike): number | null {
  const v = evt.data?.object?.current_period_start;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * Dispatch a subscription event into a credit grant. Returns the
 * outcome -- the caller decides whether to log, metric, or stash.
 */
export async function handleSubscriptionGrantEvent(
  env: Env,
  event: StripeSubscriptionEventLike,
): Promise<GrantOutcome> {
  const customer_id = customerIdOf(event);
  if (!customer_id) {
    return { kind: "tier_no_grant", tier: "unknown", reason: "missing_customer" };
  }
  const user_id = await lookupUserIdByCustomerId(env, customer_id);
  if (!user_id) {
    return { kind: "no_customer_user_mapping", customer_id };
  }

  const subscription = event.data?.object ?? null;
  const tier = inferTier(
    {
      STRIPE_PRICE_PRO_MONTHLY: env.STRIPE_PRICE_PRO_MONTHLY,
      STRIPE_PRICE_METERED: env.STRIPE_PRICE_METERED,
    },
    subscription,
  );

  if (tier.grant_uc <= 0) {
    return { kind: "tier_no_grant", tier: tier.tier, reason: tier.status ?? "no_grant" };
  }

  // D3b idempotency: one grant per customer per billing period. We
  // hash on period_start (when known); fall back to subscription.id
  // when the period isn't on the event payload, which keeps trial-
  // start one-shot events idempotent too.
  const period = periodStartOf(event);
  const idemSuffix = period !== null
    ? `period:${period}`
    : `sub:${subscription?.id ?? "unknown"}`;
  const idem_key = `${IDEM_PREFIX}${customer_id}:${idemSuffix}`;

  const kv = statsKV(env);
  const seen = (await kv.get(idem_key)) as string | null;
  if (seen) {
    return { kind: "duplicate", idem_key };
  }

  const balance = await addUserCredits(env, user_id, tier.grant_uc);
  // Write the idempotency marker AFTER the grant lands so a crash
  // between grant + marker rewrites a single duplicate next time, never
  // a missed grant.
  await kv.put(idem_key, new Date().toISOString());

  // Flywheel closure (contract organ 98973c11 G1) — carve
  // PLATFORM_REVENUE_TO_POOL_BPS off the subscription-tier grant into
  // the sponsor pool so the sponsor middleware draws from real revenue
  // instead of the platform-sponsor wallet. Idempotent on idem_key
  // (one-shot per customer per billing period); opportunistic —
  // never breaks the subscription-grant path.
  const { addSponsorPoolCredits } = await import("./sponsor-pool.js");
  await addSponsorPoolCredits(env, {
    event_id: `sub_grant:${idem_key}`,
    source: "stripe_subscription_grant",
    revenue_uc: tier.grant_uc,
  });

  return { kind: "applied", user_id, amount_uc: tier.grant_uc, balance, idem_key };
}
