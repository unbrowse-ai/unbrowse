/**
 * Stripe subscription service — wraps x402 with a subscription + overage lane.
 *
 * Day 3 (Land) seed: signatures and KV key conventions. Function bodies throw
 * `STRIPE_NOT_IMPLEMENTED` until Day 4 (Luminaries) installs the SDK and wires
 * the Stripe API. The seed is in itself (Gen 1:11): callers can compile and
 * tests can drive against the contracts.
 *
 * Boundary (firmament): this file is the SOLE writer of `stripe:*` KV keys
 * and the sole caller of `stripe.subscriptions.list` once Day 4 lands. The
 * substrate / never-hardcode rule applies: no per-tier prose, no synthetic
 * verbs, no format templates putting words in another agent's mouth — only
 * declared state surfaced through typed returns.
 */

import Stripe from "stripe";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import type {
  MinimalStripeEvent,
  STRIPE_SUB_CACHE,
  StripeSubStatus,
  SubscriptionAdmitResult,
} from "./stripe.types.js";
import { addUserCredits, UC_PER_USD } from "./user-credits.js";

export const STRIPE_NOT_IMPLEMENTED = new Error(
  "stripe.ts skeleton — implementation lands Day 4 (Luminaries)",
);

/** KV key conventions — ONLY this module reads or writes these prefixes (F2). */
export const KV_KEYS = {
  userCustomer: (userId: string) => `stripe:user:${userId}`,
  customerSub: (customerId: string) => `stripe:customer:${customerId}`,
  /**
   * Reverse index customer.id -> user_id, written at customer-creation
   * time so the webhook can resolve customer.id back to user_id without
   * scanning. Reads are O(1) KV-get. (D1b precondition for wave-3
   * tier-grant routing.)
   */
  customerUser: (customerId: string) => `stripe:customer:${customerId}:user`,
  /**
   * IQ-only billing (replaces Neon `usage_counters`). Monotonic per-period
   * usage meter. KV has no atomic increment — see recordUsage for the ACID note.
   */
  usage: (userId: string, period: string) => `billing:usage:${userId}:${period}`,
  /**
   * IQ-only billing event marker (replaces Neon `billing_events`). Presence =
   * "this Stripe event was already processed" — webhook re-deliveries noop.
   */
  billingEvent: (eventId: string) => `billing:event:${eventId}`,
} as const;

type AuthCtx = Context<{
  Bindings: Env;
  Variables: { agent_id: string; user_id?: string };
}>;

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

let _stripeClient: Stripe | null = null;
let _stripeClientKey: string | null = null;

function getStripe(env: Env): Stripe {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY not configured");
  }
  if (_stripeClient && _stripeClientKey === key) {
    return _stripeClient;
  }
  _stripeClient = new Stripe(key, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: "2026-04-22.dahlia",
  });
  _stripeClientKey = key;
  return _stripeClient;
}

function currentPeriod(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function parseSubCache(raw: string | null): STRIPE_SUB_CACHE | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as STRIPE_SUB_CACHE;
  } catch {
    return null;
  }
}

/**
 * Theo's webhook whitelist — the 19 events that affect cached subscription
 * state. All other events are ignored. This is enumeration of upstream
 * declarations (Stripe's event types), not synthesis.
 */
const ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.upcoming",
  "invoice.marked_uncollectible",
  "invoice.payment_succeeded",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "payment_intent.created",
]);

async function peekUsage(
  env: Env,
  userId: string,
  period: string,
): Promise<number> {
  const kv = statsKV(env);
  const raw = (await kv.get(KV_KEYS.usage(userId, period))) as string | null;
  const n = Number(raw ?? "0");
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Customer lifecycle
// ---------------------------------------------------------------------------

export async function getOrCreateCustomer(
  env: Env,
  userId: string,
  email: string,
): Promise<string> {
  const kv = statsKV(env);
  const existing = (await kv.get(KV_KEYS.userCustomer(userId))) as
    | string
    | null;
  if (existing && typeof existing === "string") {
    return existing;
  }
  const stripe = getStripe(env);
  const customer = await stripe.customers.create({
    email,
    metadata: { userId },
  });
  await kv.put(KV_KEYS.userCustomer(userId), customer.id);
  // Reverse index for webhook customer.id -> user_id resolution (D1b).
  await kv.put(KV_KEYS.customerUser(customer.id), userId);
  return customer.id;
}

/**
 * Webhook helper: resolve a Stripe customer.id back to the unbrowse
 * user_id that owns it. Returns null when the reverse index is missing
 * (customer created before wave 3 deployed); the caller must skip the
 * grant rather than guess. Customers created from now on will populate
 * the index automatically via getOrCreateCustomer.
 */
export async function lookupUserIdByCustomerId(
  env: Env,
  customerId: string,
): Promise<string | null> {
  const kv = statsKV(env);
  const raw = (await kv.get(KV_KEYS.customerUser(customerId))) as string | null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

// ---------------------------------------------------------------------------
// State sync — single writer of subscription cache (F6)
// ---------------------------------------------------------------------------

export async function syncStripeDataToUserKV(
  env: Env,
  customerId: string,
): Promise<STRIPE_SUB_CACHE> {
  const stripe = getStripe(env);
  const kv = statsKV(env);
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    limit: 1,
    status: "all",
    expand: ["data.default_payment_method"],
  });

  if (subs.data.length === 0) {
    const cache: STRIPE_SUB_CACHE = { status: "none" };
    await kv.put(KV_KEYS.customerSub(customerId), JSON.stringify(cache));
    return cache;
  }

  const sub = subs.data[0] as Stripe.Subscription & {
    current_period_start: number;
    current_period_end: number;
  };
  const item = sub.items.data[0];
  const price = item?.price;
  const priceMeta = (price?.metadata ?? {}) as Record<string, string>;
  const quotaRaw = priceMeta.quota;
  const quota = quotaRaw ? parseInt(quotaRaw, 10) || 1000 : 1000;
  const overagePriceId = priceMeta.overage_price_id || null;
  const overageAllowed = !!overagePriceId;

  const pm = sub.default_payment_method as Stripe.PaymentMethod | string | null;
  let paymentMethod: { brand: string | null; last4: string | null } | null =
    null;
  if (pm && typeof pm !== "string") {
    paymentMethod = {
      brand: pm.card?.brand ?? null,
      last4: pm.card?.last4 ?? null,
    };
  }

  const cache: STRIPE_SUB_CACHE = {
    status: sub.status as StripeSubStatus,
    subscriptionId: sub.id,
    priceId: price?.id ?? "",
    currentPeriodStart: sub.current_period_start ?? 0,
    currentPeriodEnd: sub.current_period_end ?? 0,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    paymentMethod,
    quota,
    overageAllowed,
    overagePriceId,
    updatedAt: Date.now(),
  };
  await kv.put(KV_KEYS.customerSub(customerId), JSON.stringify(cache));
  return cache;
}

export async function readSubFromKV(
  env: Env,
  userId: string,
): Promise<STRIPE_SUB_CACHE | null> {
  const kv = statsKV(env);
  const customerId = (await kv.get(KV_KEYS.userCustomer(userId))) as
    | string
    | null;
  if (!customerId || typeof customerId !== "string") return null;
  const raw = (await kv.get(KV_KEYS.customerSub(customerId))) as string | null;
  return parseSubCache(typeof raw === "string" ? raw : null);
}

// ---------------------------------------------------------------------------
// Admission — slotted into routes/{skills,search,demos}.ts before x402 builds
// ---------------------------------------------------------------------------

export async function subscriptionAdmits(
  env: Env,
  ctx: AuthCtx,
): Promise<SubscriptionAdmitResult> {
  const userId = ctx.get("user_id");

  // Missing user_id (Landmine 1 / Falsifier F1): fall through to x402 cleanly.
  // The legacy admin path (API_KEY → agent_id="__admin__") is NOT given an
  // escape hatch here — admin calls hit x402 like everyone else, preserving
  // the existing x402-search-route.test.ts contract.
  if (!userId) {
    return { admit: false, reason: "no_user" };
  }


  const kv = statsKV(env);
  const customerId = (await kv.get(KV_KEYS.userCustomer(userId))) as
    | string
    | null;
  if (!customerId || typeof customerId !== "string") {
    return { admit: false, reason: "no_sub" };
  }
  const raw = (await kv.get(KV_KEYS.customerSub(customerId))) as string | null;
  const sub = parseSubCache(typeof raw === "string" ? raw : null);
  if (!sub || sub.status === "none") {
    return { admit: false, reason: "no_sub", customerId };
  }
  if (sub.status !== "active" && sub.status !== "trialing") {
    return { admit: false, reason: "inactive", customerId };
  }

  const period = currentPeriod();
  const consumed = await peekUsage(env, userId, period);
  if (consumed < sub.quota) {
    return {
      admit: true,
      reason: "admit_quota",
      consumed,
      quota: sub.quota,
      customerId,
    };
  }
  if (sub.overageAllowed) {
    return {
      admit: true,
      reason: "admit_overage",
      consumed,
      quota: sub.quota,
      customerId,
    };
  }
  return {
    admit: false,
    reason: "quota_exhausted",
    consumed,
    quota: sub.quota,
    customerId,
  };
}

// ---------------------------------------------------------------------------
// Usage counter — IQ-only (EdbKV). ACID note below.
// ---------------------------------------------------------------------------

export async function recordUsage(
  env: Env,
  userId: string,
  units: number,
): Promise<{ consumed: number }> {
  // IQ-only: the per-period usage meter lives in EdbKV (statsKV), which has no
  // atomic increment. This is a read-modify-write: two concurrent debits in the
  // same period can both read N and both write N+units, losing one increment.
  // That biases the meter to UNDERcount — it favours the user and never
  // overcharges. Accepted as the Neon->IQ tradeoff; the quota gate +
  // auto-refill still catch real overage, and `period` rolls monthly so any
  // drift resets and never accumulates.
  const kv = statsKV(env);
  const period = currentPeriod();
  const key = KV_KEYS.usage(userId, period);
  const prev = Number(((await kv.get(key)) as string | null) ?? "0");
  const base = Number.isFinite(prev) && prev > 0 ? prev : 0;
  const consumed = base + units;
  await kv.put(key, String(consumed));
  return { consumed };
}

// ---------------------------------------------------------------------------
// Checkout + Portal — URLs only, never card fields (F4)
// ---------------------------------------------------------------------------

export async function createCheckoutSession(
  env: Env,
  userId: string,
  email: string,
  returnUrl: string,
  opts: { priceId?: string; tier?: "pro" | "metered" | "base" } = {},
): Promise<{ url: string; price_id: string; tier: string }> {
  // Tier picker (W5-C): caller passes `tier` (pro / metered) and we map
  // to the matching env-configured price id. Explicit priceId still wins
  // when set (admin override). Falls back to legacy STRIPE_PRICE_BASE
  // when neither is supplied so existing /billing flows keep working.
  const tier = opts.tier ?? "base";
  const fromTier =
    tier === "pro" ? env.STRIPE_PRICE_PRO_MONTHLY :
    tier === "metered" ? env.STRIPE_PRICE_METERED :
    env.STRIPE_PRICE_BASE;
  const price_id = opts.priceId ?? fromTier;
  if (!price_id) {
    throw new Error(`tier ${tier} has no configured price id`);
  }
  const customerId = await getOrCreateCustomer(env, userId, email);
  const stripe = getStripe(env);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: price_id, quantity: 1 }],
    success_url: returnUrl + "?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: returnUrl,
    allow_promotion_codes: true,
  });
  if (!session.url) {
    throw new Error("stripe checkout session returned no url");
  }
  return { url: session.url, price_id, tier };
}

export async function createPortalSession(
  env: Env,
  userId: string,
  returnUrl: string,
): Promise<{ url: string }> {
  const kv = statsKV(env);
  const customerId = (await kv.get(KV_KEYS.userCustomer(userId))) as
    | string
    | null;
  if (!customerId || typeof customerId !== "string") {
    throw new Error("no_customer");
  }
  const stripe = getStripe(env);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

// ---------------------------------------------------------------------------
// Webhook — signature-gated; processBillingEvent only accepts verified events (F5)
// ---------------------------------------------------------------------------

export async function verifyWebhookSignature(
  env: Env,
  rawBody: string,
  signature: string,
): Promise<MinimalStripeEvent> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET not configured");
  }
  const stripe = getStripe(env);
  const event = await stripe.webhooks.constructEventAsync(
    rawBody,
    signature,
    env.STRIPE_WEBHOOK_SECRET,
  );
  return event as unknown as MinimalStripeEvent;
}

export async function processBillingEvent(
  env: Env,
  event: MinimalStripeEvent,
): Promise<void> {
  if (!ALLOWED_EVENTS.has(event.type)) {
    return;
  }
  const obj = event.data?.object as
    | { customer?: string | { id?: string } }
    | undefined;
  const rawCustomer = obj?.customer;
  let customerId: string | null = null;
  if (typeof rawCustomer === "string") {
    customerId = rawCustomer;
  } else if (rawCustomer && typeof rawCustomer === "object" && rawCustomer.id) {
    customerId = rawCustomer.id;
  }
  if (!customerId) {
    return;
  }

  // IQ-only audit/idempotency marker (replaces Neon `billing_events`). We store
  // metadata only, not the full Stripe payload, to stay within EdbKV's
  // per-value size budget; the authoritative state effect is
  // syncStripeDataToUserKV below (itself idempotent). Presence of the marker
  // means "already processed" — webhook re-deliveries are a cheap noop.
  const kv = statsKV(env);
  const evKey = KV_KEYS.billingEvent(event.id);
  if (!(await kv.get(evKey))) {
    await kv.put(
      evKey,
      JSON.stringify({
        customer_id: customerId,
        event_type: event.type,
        created_at: Date.now(),
      }),
    );
  }

  await syncStripeDataToUserKV(env, customerId);

  // D3 wave 3: dispatch tier-credit grants on subscription events.
  // Fires AFTER syncStripeDataToUserKV so the cache reflects the latest
  // state before the grant. Idempotent via ${customer.id}:${period_start};
  // webhook re-deliveries noop. Non-actionable failure modes (missing
  // reverse index, free/metered tier) are logged at the appropriate
  // level; we never throw from here because Stripe retries the whole
  // event on failure.
  if (event.type?.startsWith("customer.subscription.")) {
    try {
      const { handleSubscriptionGrantEvent } = await import("./stripe-grants.js");
      const outcome = await handleSubscriptionGrantEvent(
        env,
        event as Parameters<typeof handleSubscriptionGrantEvent>[1],
      );
      if (outcome.kind === "applied") {
        console.log(
          `[stripe-grants] applied user=${outcome.user_id} amount_uc=${outcome.amount_uc} new_balance=${outcome.balance.balance_uc}`,
        );
      } else if (outcome.kind === "no_customer_user_mapping") {
        console.warn(
          `[stripe-grants] missing customer->user index for customer=${outcome.customer_id} (pre-wave-3 customer?)`,
        );
      }
      // duplicate + tier_no_grant are expected; no logging.
    } catch (err) {
      console.warn(`[stripe-grants] dispatcher threw: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-refill overage (subscription-billing-layer wave 2)
// ---------------------------------------------------------------------------
export interface AutoRefillResult {
  ok: boolean;
  reason:
    | "refilled"
    | "no_stripe"
    | "no_customer"
    | "no_payment_method"
    | "period_cap"
    | "in_progress"
    | "charge_failed";
  granted_uc?: number;
  amount_usd?: number;
  payment_intent_id?: string;
}

/**
 * Off-session auto-refill. When a subscriber's monthly-plan credit is
 * exhausted mid-cycle, charge the card on file for `STRIPE_AUTOREFILL_USD`
 * and grant the equivalent credit. Guarded by a KV lock (no concurrent
 * double-charge from a burst of insufficient-credit calls) and a per-UTC-
 * month cap so a runaway loop cannot drain a card. Returns evidence; the
 * caller (the /llm route) judges whether to retry the debit or fall to x402.
 */
export async function autoRefillUserCredits(
  env: Env,
  userId: string,
): Promise<AutoRefillResult> {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, reason: "no_stripe" };
  const kv = statsKV(env);

  const customerId = (await kv.get(KV_KEYS.userCustomer(userId))) as
    | string
    | null;
  if (!customerId || typeof customerId !== "string") {
    return { ok: false, reason: "no_customer" };
  }

  // Per-UTC-month cap: refuse once this user has hit the refill ceiling.
  const period = currentPeriod();
  const capRaw = Number(env.STRIPE_AUTOREFILL_MAX_PER_PERIOD ?? "20");
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : 20;
  const countKey = `stripe:autorefill:count:${userId}:${period}`;
  const used = Number(((await kv.get(countKey)) as string | null) ?? "0");
  if (Number.isFinite(used) && used >= cap) {
    return { ok: false, reason: "period_cap" };
  }

  // Concurrency lock: a burst of insufficient-credit calls must not each
  // fire a charge. First caller holds the lock; others see in_progress.
  const lockKey = `stripe:autorefill:lock:${userId}`;
  if (await kv.get(lockKey)) {
    return { ok: false, reason: "in_progress" };
  }
  await kv.put(lockKey, new Date().toISOString(), { expirationTtl: 120 });

  try {
    const stripe = getStripe(env);

    // Off-session charges need an explicit payment_method id. Prefer the
    // customer's default; fall back to the most recently attached card.
    let paymentMethodId: string | null = null;
    const customer = await stripe.customers.retrieve(customerId);
    if (customer && !customer.deleted) {
      const dpm = customer.invoice_settings?.default_payment_method;
      paymentMethodId = typeof dpm === "string" ? dpm : (dpm?.id ?? null);
    }
    if (!paymentMethodId) {
      const pms = await stripe.paymentMethods.list({
        customer: customerId,
        type: "card",
        limit: 1,
      });
      paymentMethodId = pms.data[0]?.id ?? null;
    }
    if (!paymentMethodId) {
      return { ok: false, reason: "no_payment_method" };
    }

    const amountUsdRaw = Number(env.STRIPE_AUTOREFILL_USD ?? "5");
    const amountUsd =
      Number.isFinite(amountUsdRaw) && amountUsdRaw > 0 ? amountUsdRaw : 5;
    const amountCents = Math.round(amountUsd * 100);

    const intent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: "usd",
        customer: customerId,
        payment_method: paymentMethodId,
        off_session: true,
        confirm: true,
        description: `AikoNotch credit auto-refill (${period})`,
        metadata: { userId, kind: "autorefill", period },
      },
      {
        idempotencyKey: `autorefill:${userId}:${period}:${Math.floor(
          Date.now() / 60_000,
        )}`,
      },
    );

    if (intent.status !== "succeeded") {
      return { ok: false, reason: "charge_failed", payment_intent_id: intent.id };
    }

    const grantedUc = Math.round(amountUsd * UC_PER_USD);
    await addUserCredits(env, userId, grantedUc);
    await kv.put(countKey, String(used + 1), {
      expirationTtl: 60 * 60 * 24 * 40,
    });

    // Flywheel closure (contract organ 98973c11 G1) — carve
    // PLATFORM_REVENUE_TO_POOL_BPS off the granted revenue into the
    // sponsor pool so future sponsored executes draw from real revenue
    // instead of the platform-sponsor wallet. Idempotent on
    // intent.id; opportunistic — never breaks the auto-refill path.
    const { addSponsorPoolCredits } = await import("./sponsor-pool.js");
    await addSponsorPoolCredits(env, {
      event_id: `autorefill:${intent.id}`,
      source: "stripe_autorefill",
      revenue_uc: grantedUc,
    });

    return {
      ok: true,
      reason: "refilled",
      granted_uc: grantedUc,
      amount_usd: amountUsd,
      payment_intent_id: intent.id,
    };
  } catch (err) {
    console.warn("[autorefill] charge failed:", (err as Error).message);
    return { ok: false, reason: "charge_failed" };
  } finally {
    await kv.delete(lockKey).catch(() => {});
  }
}
