/**
 * delegation-ledger — the rolling cap ledger for the non-custodial delegated
 * funding lane (design §5, Phase 4 brought forward as Phase-1 foundation).
 *
 * Each Flex authorization is independently `maxAmount`-bounded ON-CHAIN, but
 * nothing on-chain links SUCCESSIVE authorizations to one delegated budget. This
 * ledger enforces the SUM off-chain so many small bounded draws can't exceed the
 * delegated `cap_uc`.
 *
 * Shape: the append-only event-log + projection pattern already adopted for the
 * economic ledgers (route-ledger / ledger-unification). The EVENTS are the
 * settled draws, content-addressed by `authorization_id`; the PROJECTION is the
 * sum `spent_uc`. Keying each draw under its `authorization_id` makes the write
 * IDEMPOTENT — re-recording the same authorization (a settle replay) writes the
 * same key with the same amount, so it cannot double-count even on a no-CAS
 * (last-write-wins) store. No atomic compare-and-set required: the projection is
 * derived at read time by summing distinct event keys, never raced into a mutable
 * accumulator (which would silently lose credits under concurrency).
 *
 * Phase-1 NOTE: this records draws and projects spend. It does NOT sign, settle,
 * or move funds — settlement (the thing that PRODUCES an authorization_id) is
 * Phase 2. This is the off-chain ceiling that Phase 2 will debit against.
 */
import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

// delegdraw:<keyId>:<authorization_id> -> { authorization_id, amount_uc, ts }
const DRAW_PREFIX = "delegdraw:";

export interface DelegationDraw {
  authorization_id: string;
  amount_uc: number;
  ts: string;
}

function drawKey(keyId: string, authorizationId: string): string {
  return `${DRAW_PREFIX}${keyId}:${authorizationId}`;
}

/**
 * Record a settled draw against a delegated key. IDEMPOTENT on
 * authorization_id: the same authorization recorded twice writes the same
 * content-addressed key, so a settle replay does NOT double-count. Returns the
 * stored draw (the existing one when it was already recorded). Invalid amounts
 * (non-finite or <= 0) are rejected — a draw must move a positive amount.
 */
export async function recordDelegationDraw(
  env: Env,
  keyId: string,
  draw: { authorization_id: string; amount_uc: number },
): Promise<{ ok: true; draw: DelegationDraw } | { ok: false; reason: "invalid_amount" | "invalid_authorization_id" }> {
  const authId = draw.authorization_id?.trim();
  if (!authId) return { ok: false, reason: "invalid_authorization_id" };
  if (!Number.isFinite(draw.amount_uc) || draw.amount_uc <= 0) {
    return { ok: false, reason: "invalid_amount" };
  }
  const kv = statsKV(env);
  const key = drawKey(keyId, authId);
  const existingRaw = (await kv.get(key)) as string | null;
  if (existingRaw) {
    // Already recorded — idempotent no-op. Return the stored draw verbatim so a
    // replay observes the same amount, never an accumulation.
    try {
      return { ok: true, draw: JSON.parse(existingRaw) as DelegationDraw };
    } catch {
      // Corrupt prior record — fall through and rewrite it canonically.
    }
  }
  const rec: DelegationDraw = {
    authorization_id: authId,
    amount_uc: Math.floor(draw.amount_uc),
    ts: new Date().toISOString(),
  };
  await kv.put(key, JSON.stringify(rec));
  return { ok: true, draw: rec };
}

/** Read every recorded draw for a key (content-addressed; order-independent). */
export async function readDelegationDraws(env: Env, keyId: string): Promise<DelegationDraw[]> {
  const rows = await statsKV(env).listWithValues(`${DRAW_PREFIX}${keyId}:`);
  const out: DelegationDraw[] = [];
  for (const row of rows) {
    if (!row.value) continue;
    try {
      out.push(JSON.parse(row.value) as DelegationDraw);
    } catch {
      /* skip an unparseable row rather than corrupt the projection */
    }
  }
  return out;
}

/** The projection: total µ¢ drawn against this delegated key, summed from the event log. */
export async function delegationSpent(env: Env, keyId: string): Promise<number> {
  const draws = await readDelegationDraws(env, keyId);
  let total = 0;
  for (const d of draws) {
    if (Number.isFinite(d.amount_uc) && d.amount_uc > 0) total += d.amount_uc;
  }
  return total;
}

/**
 * Remaining headroom under the delegated cap: cap_uc - spent. Clamped at 0 so an
 * over-projection never reports negative headroom. The admission lane (Phase 2)
 * refuses a draw once this hits 0, falling through to a per-call 402 exactly like
 * an exhausted prepaid balance.
 */
export async function delegationRemaining(env: Env, keyId: string, capUc: number): Promise<number> {
  const spent = await delegationSpent(env, keyId);
  return Math.max(0, Math.floor(capUc) - spent);
}
