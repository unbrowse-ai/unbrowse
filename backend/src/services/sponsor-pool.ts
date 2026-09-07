/**
 * Sponsor-pool service — the load-bearing closure of the flywheel
 * (contract organ 98973c11 stage G1, 411c31e1).
 *
 * The publish-to-earn audit (docs/internal/flywheel-payment-audit.md G1
 * + flywheel-closure-trace.md) named the missing edge: every
 * Stripe-revenue path lands credits in the *user's* per-user balance via
 * addUserCredits, but the sponsor middleware draws from the platform
 * wallet — the two ledgers never meet. This module is the edge.
 *
 * On every credit-granting REVENUE event (subscription tier grant or
 * auto-refill overage), the call site invokes `addSponsorPoolCredits`
 * with a fraction of the granted credits carved off per the env-bound
 * `PLATFORM_REVENUE_TO_POOL_BPS` (default 1000 bps = 10%, paper-
 * faithful per arXiv 2604.00694 §3.5 "infrastructure ≈ 10% platform
 * toll"). The carved credits accumulate in `sponsor:pool:balance:uc`
 * (running USDC-equivalent pool in micro-cents). The sponsor middleware
 * draws from this pool BEFORE falling back to
 * PLATFORM_SPONSOR_WALLET_ADDRESS, closing the loop.
 *
 * Idempotency: every credit row carries an event-id key; re-delivered
 * Stripe webhooks no-op cleanly on the journal row check.
 *
 * KV layout:
 *   sponsor:pool:balance:uc                  — integer micro-cents (string)
 *   sponsor:pool:journal:<event_id>          — JSON row per contribution (idempotent)
 *
 * Env knobs:
 *   PLATFORM_REVENUE_TO_POOL_BPS  — bps of revenue carved off (default 1000 = 10%)
 */

import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

/**
 * Read/write the KV. Mirrors the sponsor middleware pattern at
 * backend/src/middleware/sponsor.ts:166-210 — try statsKV first
 * (production: Pg / EmergentDB / LocalKV), fall back to the raw
 * env.STATS_KV (tests: in-memory KVNamespace). Both surfaces honour
 * the same `get / put` interface for our purposes.
 */
async function kvGet(env: Env, key: string): Promise<string | null> {
  return (await statsKV(env).get(key)) as string | null;
}

async function kvPut(env: Env, key: string, value: string): Promise<void> {
  await statsKV(env).put(key, value);
}

const POOL_BALANCE_KEY = "sponsor:pool:balance:uc";
const POOL_JOURNAL_PREFIX = "sponsor:pool:journal:";

/** Default contribution rate when PLATFORM_REVENUE_TO_POOL_BPS is unset. */
export const DEFAULT_PLATFORM_REVENUE_TO_POOL_BPS = 1000; // 10% — paper §3.5

export interface SponsorPoolContribution {
  /** Stripe event id (or other source-unique id) — used as idempotency key. */
  event_id: string;
  /** Source path that triggered the contribution. */
  source: "stripe_subscription_grant" | "stripe_autorefill" | "manual_admin" | "test";
  /** Original revenue amount in user-credits-µ¢ before the carve-off. */
  revenue_uc: number;
  /** µ¢ actually added to the pool. */
  contribution_uc: number;
  /** bps used for this contribution (snapshot of env var at write time). */
  rate_bps: number;
  /** ISO timestamp of the contribution. */
  ts: string;
}

/**
 * Carve a fraction of granted revenue into the sponsor pool.
 *
 * Returns the actual µ¢ added (zero if idempotent skip, or if rate_bps
 * is zero, or if the KV write fails — never throws from here so the
 * webhook caller still acks Stripe).
 */
export async function addSponsorPoolCredits(
  env: Env,
  args: {
    event_id: string;
    source: SponsorPoolContribution["source"];
    revenue_uc: number;
    /** Override the env default; useful for tests. */
    rate_bps_override?: number;
  },
): Promise<{ added_uc: number; new_balance_uc: number; idempotent_skip: boolean }> {
  try {
    const journalKey = `${POOL_JOURNAL_PREFIX}${args.event_id}`;

    // Idempotency check — re-delivered events no-op cleanly.
    const existing = await kvGet(env, journalKey);
    if (existing) {
      const balance = Number((await kvGet(env, POOL_BALANCE_KEY)) ?? "0");
      return { added_uc: 0, new_balance_uc: balance, idempotent_skip: true };
    }

    // Resolve rate: override (tests) > env > default.
    const envRate = Number(env.PLATFORM_REVENUE_TO_POOL_BPS);
    const rateBps =
      typeof args.rate_bps_override === "number" && Number.isFinite(args.rate_bps_override) && args.rate_bps_override >= 0
        ? Math.min(10000, Math.round(args.rate_bps_override))
        : Number.isFinite(envRate) && envRate >= 0
          ? Math.min(10000, Math.round(envRate))
          : DEFAULT_PLATFORM_REVENUE_TO_POOL_BPS;

    if (rateBps === 0) {
      // Pool disabled — still write a journal row so the idempotency
      // check above stays meaningful, but contribute 0.
      const row: SponsorPoolContribution = {
        event_id: args.event_id,
        source: args.source,
        revenue_uc: args.revenue_uc,
        contribution_uc: 0,
        rate_bps: 0,
        ts: new Date().toISOString(),
      };
      await kvPut(env, journalKey, JSON.stringify(row));
      const balance = Number((await kvGet(env, POOL_BALANCE_KEY)) ?? "0");
      return { added_uc: 0, new_balance_uc: balance, idempotent_skip: false };
    }

    const contributionUc = Math.floor((args.revenue_uc * rateBps) / 10000);
    if (contributionUc <= 0) {
      // Sub-µ¢ rounded to zero — record but don't increment.
      const row: SponsorPoolContribution = {
        event_id: args.event_id,
        source: args.source,
        revenue_uc: args.revenue_uc,
        contribution_uc: 0,
        rate_bps: rateBps,
        ts: new Date().toISOString(),
      };
      await kvPut(env, journalKey, JSON.stringify(row));
      const balance = Number((await kvGet(env, POOL_BALANCE_KEY)) ?? "0");
      return { added_uc: 0, new_balance_uc: balance, idempotent_skip: false };
    }

    // Read-modify-write the running balance. KV is eventually consistent;
    // we tolerate a small drift window in exchange for not needing a
    // strong-consistency primitive. The journal row is the durable record;
    // the balance row is the fast-path materialised view.
    const currentBalance = Number((await kvGet(env, POOL_BALANCE_KEY)) ?? "0");
    const newBalance = currentBalance + contributionUc;

    const row: SponsorPoolContribution = {
      event_id: args.event_id,
      source: args.source,
      revenue_uc: args.revenue_uc,
      contribution_uc: contributionUc,
      rate_bps: rateBps,
      ts: new Date().toISOString(),
    };

    // Write journal first (durable record), balance second (materialised view).
    // If the second write fails, a recovery script can rebuild balance from
    // sum(journal rows) — append-only is recoverable; mutated balance is not.
    await kvPut(env, journalKey, JSON.stringify(row));
    await kvPut(env, POOL_BALANCE_KEY, String(newBalance));

    return { added_uc: contributionUc, new_balance_uc: newBalance, idempotent_skip: false };
  } catch (err) {
    // The flywheel closure is opportunistic — a KV failure here must NOT
    // break the underlying revenue path (the user got their credits;
    // Stripe got their ack). Log and move on; recovery scripts can
    // backfill from billing_events later.
    console.warn(
      `[sponsor-pool] addSponsorPoolCredits failed event=${args.event_id} source=${args.source}: ${(err as Error).message}`,
    );
    return { added_uc: 0, new_balance_uc: 0, idempotent_skip: false };
  }
}

/**
 * Read the current pool balance. Returns 0 when the KV row is absent
 * (uninitialised — fresh deploy, first-revenue not yet landed).
 */
export async function getSponsorPoolBalance(env: Env): Promise<number> {
  try {
    return Number((await kvGet(env, POOL_BALANCE_KEY)) ?? "0");
  } catch {
    return 0;
  }
}

/**
 * Attempt to draw from the pool to fund a sponsored execute.
 *
 * Returns `{ drawn_uc: spendUc }` if the pool had sufficient balance and
 * the draw succeeded. Returns `{ drawn_uc: 0 }` if the pool was empty
 * (caller falls back to PLATFORM_SPONSOR_WALLET_ADDRESS — today's
 * behaviour).
 *
 * Idempotency: callers pass a `draw_id` (typically the sponsor ledger
 * row id) so retries with the same id are a no-op after the first.
 */
export async function drawFromSponsorPool(
  env: Env,
  args: { draw_id: string; spend_uc: number },
): Promise<{ drawn_uc: number; new_balance_uc: number; idempotent_skip: boolean }> {
  try {
    const drawKey = `${POOL_JOURNAL_PREFIX}draw:${args.draw_id}`;

    const existing = await kvGet(env, drawKey);
    if (existing) {
      const balance = await getSponsorPoolBalance(env);
      return { drawn_uc: 0, new_balance_uc: balance, idempotent_skip: true };
    }

    const currentBalance = await getSponsorPoolBalance(env);
    if (currentBalance < args.spend_uc) {
      // Pool too small — caller falls back to platform wallet.
      return { drawn_uc: 0, new_balance_uc: currentBalance, idempotent_skip: false };
    }

    const newBalance = currentBalance - args.spend_uc;
    const row = {
      draw_id: args.draw_id,
      spend_uc: args.spend_uc,
      balance_after_uc: newBalance,
      ts: new Date().toISOString(),
    };

    await kvPut(env, drawKey, JSON.stringify(row));
    await kvPut(env, POOL_BALANCE_KEY, String(newBalance));

    return { drawn_uc: args.spend_uc, new_balance_uc: newBalance, idempotent_skip: false };
  } catch (err) {
    console.warn(
      `[sponsor-pool] drawFromSponsorPool failed draw_id=${args.draw_id}: ${(err as Error).message}`,
    );
    return { drawn_uc: 0, new_balance_uc: 0, idempotent_skip: false };
  }
}
