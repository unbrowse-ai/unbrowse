/**
 * Stripe subscription cache + admission types.
 *
 * Boundary (Day 2 firmament): this is the ONLY module that defines the shape of
 * subscription state outside `services/stripe.ts`. Reading these types does not
 * import the Stripe SDK — see `services/stripe.ts` for the SDK-bound functions.
 *
 * Falsifier F6 enforcement: any code that wants to read sub state imports from
 * here OR from `readSubFromKV` — never directly from `stripe.subscriptions.list`.
 */

export type StripeSubStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid"
  | "paused";

export type STRIPE_SUB_CACHE =
  | { status: "none" }
  | {
      status: StripeSubStatus;
      subscriptionId: string;
      priceId: string;
      currentPeriodStart: number;
      currentPeriodEnd: number;
      cancelAtPeriodEnd: boolean;
      paymentMethod: { brand: string | null; last4: string | null } | null;
      quota: number;
      overageAllowed: boolean;
      overagePriceId: string | null;
      updatedAt: number;
    };

export interface SubscriptionAdmitResult {
  admit: boolean;
  reason:
    | "no_user"
    | "no_sub"
    | "inactive"
    | "quota_exhausted"
    | "admit_quota"
    | "admit_overage"
    | "admit_admin";
  consumed?: number;
  quota?: number;
  customerId?: string;
}

export interface BillingEvent {
  id: string;
  customer_id: string;
  user_id: string | null;
  event_type: string;
  payload_json: string;
  created_at: string;
}

/**
 * Minimal local Stripe.Event shape — we depend only on these fields at the
 * admission layer. The full Stripe SDK type is imported only inside
 * `services/stripe.ts` (Day 4) where webhook bodies are constructed.
 */
export interface MinimalStripeEvent {
  id: string;
  type: string;
  data: { object: { customer?: string; [k: string]: unknown } };
}
