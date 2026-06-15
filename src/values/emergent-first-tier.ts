/**
 * emergent-first-tier — THE single durable-store priority authority. Every durable read/write in
 * the value layer routes through here so the order is decided in exactly ONE place and is identical
 * everywhere (the consistency directive): EmergentDB is tried before anything else.
 *
 *   EmergentDB KV   (EMERGENTDB_API_KEY present)  — first, always; wraps the IQ on-chain substrate
 *   R2 + IQ direct  (future widening)              — fallback when EDB is unconfigured
 *   local fs        (caller's default)             — last, when nothing durable is configured
 *
 * Fail-closed: with no durable creds the adapter returns null and the caller uses its local fs path,
 * byte-identical to today. The ordering itself is exported (`tierSource`) so it is witnessable and
 * so no other module re-derives store priority — they call this.
 */
import { kvGet, kvSet } from "./emergentdb-vectors.js";

export type TierSource = "emergentdb" | "r2+iq" | "none";

/** A minimal durable KV: read/write one string value by key. The energy ledger's whole need. */
export interface DurableKV {
  readonly source: TierSource;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
}

function hasEmergentDB(env: Record<string, string | undefined>): boolean {
  return !!env.EMERGENTDB_API_KEY?.trim();
}

function hasR2(env: Record<string, string | undefined>): boolean {
  // mirrors r2ConfigFromEnv's required quartet; presence only (no construction here).
  return !!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_ACCOUNT_ID);
}

/**
 * The single ordering decision: which durable tier this env selects. EmergentDB first, always; then
 * R2+IQ; else none (fs). Every durable-store call site asks THIS — never re-implements the order.
 */
export function tierSource(env: Record<string, string | undefined> = process.env): TierSource {
  if (hasEmergentDB(env)) return "emergentdb";
  if (hasR2(env)) return "r2+iq";
  return "none";
}

/**
 * The emergent-first durable KV, or null when nothing durable is configured (caller → local fs).
 * EmergentDB is returned first whenever it is configured, regardless of what else is present —
 * that is the directive. R2+IQ as a DurableKV is a named future widening; until then a non-EDB
 * remote selects null here (the value tier keeps its own R2/IQ path) so behaviour never regresses.
 */
export function emergentFirstKV(env: Record<string, string | undefined> = process.env): DurableKV | null {
  if (tierSource(env) === "emergentdb") {
    return { source: "emergentdb", get: kvGet, set: kvSet };
  }
  return null;
}
