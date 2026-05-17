/**
 * W5-B: per-execute Stripe Meter fire (unbrowse-payments-faremeter wave 5).
 *
 * Single helper that the paid-execute path calls once a call has been
 * admitted (Flex authorized / sponsor admitted / key-funded debit). It:
 *  1. resolves the calling user_id -> Stripe customer.id
 *  2. reads the cached subscription state
 *  3. calls inferTier; if tier === "metered", enqueues a meter event
 *  4. schedules flushMeterRing via executionCtx.waitUntil so the Stripe
 *     POST doesn't block the response
 *
 * Free / Pro / no-subscription callers skip silently. This is fire-
 * and-forget; errors are logged and never bubble.
 */

import type { Context } from "hono";
import type { Env } from "../types.js";
import { statsKV } from "./kv.js";
import { KV_KEYS } from "./stripe.js";
import { inferTier, type StripeSubscriptionLike } from "./stripe-tier-detection.js";
import { enqueueMeterEvent, flushMeterRing } from "./stripe-meter-ring.js";

interface SubCache {
  status?: string | null;
  priceId?: string | null;
}
function makeExecutionId(skillId: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${skillId.slice(0, 16)}:${Date.now()}:${nonce}`;
}

/**
 * Fire a meter event for this paid execute if (and only if) the calling
 * user is on the metered tier. Returns the queued event key on enqueue,
 * null when skipped. Schedules a background flush via the passed
 * `schedule` function (which the caller wraps around
 * `c.executionCtx.waitUntil` to drain without blocking the response).
 */
export async function fireMeterIfMetered(
  c: Context<{ Bindings: Env; Variables: { agent_id: string; user_id?: string } }>,
  opts: {
    skill_id: string;
    price_usd: number;
    schedule: (task: Promise<unknown>) => void;
  },
): Promise<string | null> {
  const user_id = c.get("user_id");
  if (!user_id) return null;
  const kv = statsKV(c.env);

  // Resolve customer.id from the per-user index Stripe writes at
  // getOrCreateCustomer time.
  const customer_id = (await kv.get(KV_KEYS.userCustomer(user_id))) as string | null;
  if (!customer_id) return null;

  // Read cached subscription state.
  const subRaw = (await kv.get(KV_KEYS.customerSub(customer_id))) as string | null;
  if (!subRaw) return null;
  let cache: SubCache;
  try {
    cache = JSON.parse(subRaw) as SubCache;
  } catch {
    return null;
  }
  // Reconstruct a StripeSubscriptionLike from the flat cache shape that
  // syncStripeDataToUserKV writes (status + priceId).
  const subscription: StripeSubscriptionLike | null = cache.priceId
    ? {
        status: cache.status ?? null,
        items: { data: [{ price: { id: cache.priceId } }] },
      }
    : null;

  const tier = inferTier(
    {
      STRIPE_PRICE_PRO_MONTHLY: c.env.STRIPE_PRICE_PRO_MONTHLY,
      STRIPE_PRICE_METERED: c.env.STRIPE_PRICE_METERED,
    },
    subscription,
  );
  if (tier.tier !== "metered") return null;

  const amount_uc = Math.max(1, Math.round(opts.price_usd * 1_000_000));
  const execution_id = makeExecutionId(opts.skill_id);
  const eventKey = await enqueueMeterEvent(c.env, {
    user_id,
    stripe_customer_id: customer_id,
    execution_id,
    amount_uc,
  });
  if (!eventKey) return null;

  // Schedule a background drain. Failures are logged inside flushMeterRing.
  opts.schedule(
    flushMeterRing(c.env, { max: 50 }).catch((err) =>
      console.warn(`[meter-on-execute] background flush threw: ${(err as Error).message}`),
    ),
  );
  return eventKey;
}
