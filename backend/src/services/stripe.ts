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
import { getNeonClient } from "./neon.js";
import type {
  MinimalStripeEvent,
  STRIPE_SUB_CACHE,
  StripeSubStatus,
  SubscriptionAdmitResult,
} from "./stripe.types.js";

export const STRIPE_NOT_IMPLEMENTED = new Error(
  "stripe.ts skeleton — implementation lands Day 4 (Luminaries)",
);

/** KV key conventions — ONLY this module reads or writes these prefixes (F2). */
export const KV_KEYS = {
  userCustomer: (userId: string) => `stripe:user:${userId}`,
  customerSub: (customerId: string) => `stripe:customer:${customerId}`,
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

// DDL bootstrap — one init promise per DATABASE_URL, mirrors neon.ts pattern.
const _billingInitCache = new Map<string, Promise<void>>();

async function ensureBillingTables(env: Env): Promise<unknown> {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required for billing tables");
  }
  const sql = await getNeonClient(url);
  let init = _billingInitCache.get(url);
  if (!init) {
    init = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS usage_counters (
          user_id text NOT NULL,
          period text NOT NULL,
          consumed integer NOT NULL DEFAULT 0,
          PRIMARY KEY (user_id, period)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS billing_events (
          id text PRIMARY KEY,
          customer_id text NOT NULL,
          user_id text,
          event_type text NOT NULL,
          payload_json jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS billing_events_customer_idx
        ON billing_events(customer_id, created_at DESC)
      `;
    })().catch((e) => {
      _billingInitCache.delete(url);
      throw e;
    });
    _billingInitCache.set(url, init);
  }
  await init;
  return sql;
}

async function peekUsage(
  env: Env,
  userId: string,
  period: string,
): Promise<number> {
  const sql = (await ensureBillingTables(env)) as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<Array<{ consumed: number }>>;
  const rows = await sql`
    SELECT consumed FROM usage_counters
    WHERE user_id = ${userId} AND period = ${period}
    LIMIT 1
  `;
  if (!rows || rows.length === 0) return 0;
  return Number(rows[0].consumed) || 0;
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
  return customer.id;
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
  const agentId = ctx.get("agent_id");

  // Admin escape hatch (Landmine 4): API_KEY env path sets agent_id="__admin__"
  // with no user_id. Admit, but do NOT debit a counter.
  if (!userId && agentId === "__admin__") {
    return { admit: true, reason: "admit_admin" };
  }

  // Missing user_id (Landmine 1 / Falsifier F1): fall through to x402 cleanly.
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
// Atomic usage counter — Neon upsert; not KV RMW (Landmine 2)
// ---------------------------------------------------------------------------

export async function recordUsage(
  env: Env,
  userId: string,
  units: number,
): Promise<{ consumed: number }> {
  const sql = (await ensureBillingTables(env)) as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<Array<{ consumed: number }>>;
  const period = currentPeriod();
  const rows = await sql`
    INSERT INTO usage_counters (user_id, period, consumed)
    VALUES (${userId}, ${period}, ${units})
    ON CONFLICT (user_id, period)
    DO UPDATE SET consumed = usage_counters.consumed + EXCLUDED.consumed
    RETURNING consumed
  `;
  const consumed = rows && rows[0] ? Number(rows[0].consumed) : units;
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
): Promise<{ url: string }> {
  if (!env.STRIPE_PRICE_BASE) {
    throw new Error("STRIPE_PRICE_BASE not configured");
  }
  const customerId = await getOrCreateCustomer(env, userId, email);
  const stripe = getStripe(env);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: env.STRIPE_PRICE_BASE, quantity: 1 }],
    success_url: returnUrl + "?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: returnUrl,
    allow_promotion_codes: true,
  });
  if (!session.url) {
    throw new Error("stripe checkout session returned no url");
  }
  return { url: session.url };
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

  const sql = (await ensureBillingTables(env)) as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown[]>;
  await sql`
    INSERT INTO billing_events (id, customer_id, user_id, event_type, payload_json)
    VALUES (${event.id}, ${customerId}, ${null}, ${event.type}, ${JSON.stringify(event)}::jsonb)
    ON CONFLICT (id) DO NOTHING
  `;

  await syncStripeDataToUserKV(env, customerId);
}
