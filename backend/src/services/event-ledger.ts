/**
 * Shared append-only event-ledger primitive — the ONE structural interface the
 * economic ledgers (attribution, fees, credits) settle on (see
 * LEDGER-UNIFICATION-PLAN.md). Each ledger keeps its own bespoke PROJECTION
 * (the fold differs: Σfee, by_operation, granted/earned/consumed) but shares the
 * storage discipline: content-addressed / distinct-key append → no lost update on
 * the CAS-free KV; balances are a fold over immutable rows, never a mutated blob.
 *
 * This is the superpattern realized at the data layer — recognize by SHAPE (an
 * append-only partitioned event log), not three hand-rolled copies.
 */
import { statsKV } from "./kv.js";

type KV = ReturnType<typeof statsKV>;

/** Hex sha256 of a UTF-8 string — the content-address for idempotent event keys. */
export async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Event key: `<prefix><partition>:<id>`. `id` is a content hash (idempotent) or a
 *  uuid (distinct-per-event). Distinct ids never overwrite → no lost update. */
export function eventKey(prefix: string, partition: string, id: string): string {
  return `${prefix}${partition}:${id}`;
}

/** Append one event row (idempotent when `id` is a content hash of the event). */
export async function appendEvent(kv: KV, prefix: string, partition: string, id: string, value: unknown): Promise<void> {
  await kv.put(eventKey(prefix, partition, id), JSON.stringify(value));
}

/** Read all events in one partition (the input to a projection/fold). Skips corrupt rows. */
export async function readEvents<T>(kv: KV, prefix: string, partition: string): Promise<T[]> {
  const rows = await kv.listWithValues(`${prefix}${partition}:`);
  const out: T[] = [];
  for (const { value } of rows) {
    try { out.push(JSON.parse(value) as T); } catch { /* skip corrupt row */ }
  }
  return out;
}

/** Distinct partition ids across the whole keyspace (replaces race-prone index blobs). */
export async function listPartitions<T>(kv: KV, prefix: string, key: (t: T) => string): Promise<string[]> {
  const rows = await kv.listWithValues(prefix);
  const ids = new Set<string>();
  for (const { value } of rows) {
    try { ids.add(key(JSON.parse(value) as T)); } catch { /* skip corrupt row */ }
  }
  return Array.from(ids);
}
