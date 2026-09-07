/**
 * D2b background Stripe Meter API ring (wave 4 of
 * unbrowse-payments-faremeter).
 *
 * The metered tier bills per chargeable execute via Stripe's Meter API
 * (replaces the deprecated usage_records). Inline POSTs from the hot
 * path would add a Stripe HTTPS round-trip to every paid call -- bad
 * for p99. This module queues meter events in KV and flushes them in
 * batches via `executionCtx.waitUntil` so the response goes back to
 * the agent immediately while the meter call drains in the background.
 *
 * Loss model: events are persisted in KV before the response returns,
 * so an isolate eviction loses at most the batch currently in flight
 * to Stripe (typically <= 100 events). Re-delivery is safe -- every
 * event carries an idempotency key `${user_id}:${execution_id}` so a
 * second send for the same execute noops Stripe-side.
 *
 * Ring layout in KV:
 *   meter_ring:pending:<unix_ms>:<nonce> -> JSON event (TTL 24h)
 * Each event is its own key so concurrent writers don't race on a
 * single ring head. Flush enumerates `meter_ring:pending:` and POSTs
 * each, then deletes on success.
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

const RING_PREFIX = "meter_ring:pending:";
const DEFAULT_EVENT_NAME = "unbrowse_execute";
const EVENT_TTL_SECONDS = 24 * 60 * 60; // 24h: long enough for any reasonable Stripe outage

export interface MeterEvent {
  /** Idempotency-key payload component; combined with stripe_customer_id below. */
  user_id: string;
  /** Stripe customer.id for the user. Required by the Stripe Meter API. */
  stripe_customer_id: string;
  /** The execution that triggered this meter event. Used in the idempotency key. */
  execution_id: string;
  /** Amount to record on the meter (micro-cents = 1/1_000_000 USD). */
  amount_uc: number;
  /** Optional override of the event name (defaults to STRIPE_METER_EVENT_NAME or "unbrowse_execute"). */
  event_name?: string;
  /** ISO timestamp the event was queued (set by enqueue). */
  queued_at?: string;
}

interface StoredMeterEvent extends MeterEvent {
  queued_at: string;
}

function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function ringKey(): string {
  return `${RING_PREFIX}${Date.now()}:${makeNonce()}`;
}

/**
 * Enqueue a meter event. Returns the KV key it was written to so
 * tests can verify the queue without scanning. Errors are swallowed
 * (logged) -- the paid execute already succeeded; losing a meter
 * event is preferable to failing the response.
 */
export async function enqueueMeterEvent(
  env: Env,
  event: MeterEvent,
): Promise<string | null> {
  if (!event.user_id || !event.execution_id || !event.stripe_customer_id) {
    return null;
  }
  if (!Number.isFinite(event.amount_uc) || event.amount_uc <= 0) {
    return null;
  }
  const stored: StoredMeterEvent = {
    ...event,
    queued_at: new Date().toISOString(),
  };
  const key = ringKey();
  try {
    // No TTL: the persistent KV index only tracks non-TTL entries, and
    // list() reads the index. Flush is the cleanup mechanism; a stuck
    // event lingers until Stripe accepts it or until an operator drains
    // the prefix manually.
    await statsKV(env).put(key, JSON.stringify(stored));
    return key;
  } catch (err) {
    console.warn(`[meter-ring] enqueue failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Drain pending meter events to Stripe in a single flush. Returns the
 * counts so callers can metric. Each event POSTs to the Stripe Meter
 * API individually; the idempotency-key header lets retries land
 * harmlessly.
 *
 * Why per-event instead of `billing.meterEvents.createBatch`: Stripe's
 * batch endpoint has stricter rate-limit semantics and the per-event
 * path gives us per-event success/failure visibility (which we need
 * given the ring is best-effort, not transactional).
 */
export async function flushMeterRing(
  env: Env,
  opts: { max?: number; stripe?: unknown } = {},
): Promise<{ flushed: number; failed: number; remaining: number }> {
  const kv = statsKV(env);
  const list = await kv.list({ prefix: RING_PREFIX, limit: opts.max ?? 100 });
  if (list.keys.length === 0) {
    return { flushed: 0, failed: 0, remaining: 0 };
  }

  // Lazy-import Stripe so the cold path of a non-billing request stays
  // light. The caller can inject a Stripe client for tests via opts.stripe.
  let stripeClient = opts.stripe as {
    billing?: { meterEvents?: { create: (...args: unknown[]) => Promise<unknown> } };
  } | undefined;
  if (!stripeClient && env.STRIPE_SECRET_KEY) {
    const StripeMod = (await import("stripe")).default;
    stripeClient = new StripeMod(env.STRIPE_SECRET_KEY) as unknown as typeof stripeClient;
  }
  if (!stripeClient?.billing?.meterEvents) {
    return { flushed: 0, failed: 0, remaining: list.keys.length };
  }

  const defaultEventName =
    (env.STRIPE_METER_EVENT_NAME?.trim() || DEFAULT_EVENT_NAME);

  let flushed = 0;
  let failed = 0;
  for (const entry of list.keys) {
    const raw = (await kv.get(entry.name)) as string | null;
    if (!raw) {
      failed++;
      continue;
    }
    let evt: StoredMeterEvent;
    try {
      evt = JSON.parse(raw) as StoredMeterEvent;
    } catch {
      // Corrupt entry; drop it so the ring doesn't get stuck.
      await kv.delete(entry.name);
      failed++;
      continue;
    }

    try {
      await stripeClient.billing.meterEvents.create(
        {
          event_name: evt.event_name?.trim() || defaultEventName,
          payload: {
            stripe_customer_id: evt.stripe_customer_id,
            value: String(evt.amount_uc),
          },
        },
        {
          idempotencyKey: `${evt.user_id}:${evt.execution_id}`,
        },
      );
      await kv.delete(entry.name);
      flushed++;
    } catch (err) {
      // Leave the entry in the ring; next flush will retry. The
      // idempotency key protects us against partial duplicates.
      console.warn(
        `[meter-ring] flush event ${entry.name} failed: ${(err as Error).message}`,
      );
      failed++;
    }
  }

  return {
    flushed,
    failed,
    remaining: list.keys.length - flushed,
  };
}
