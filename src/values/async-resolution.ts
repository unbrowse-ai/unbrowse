/**
 * async-resolution — the remote tier of the resolution-ledger (src/values/resolution-ledger.ts).
 *
 * The local tier is synchronous (in-process / fs). The remote tier is async because a
 * blob lives in an object store (Cloudflare R2 now, EmergentDB later) and the ledger of
 * resolutions lives on-chain (IQLabs / Solana). Same shape, one altitude out: a
 * signature is the KV key to a content-addressed pointer that resolves on truth
 * resolution; the append-only ledger keeps the SIGNED HISTORY of every past value, so
 * you can read what a resolution used to be (git-style), not just its latest value.
 *
 * Adapters implement these two interfaces:
 *   - AsyncBlobStore       → r2-blob-store.ts (Cloudflare R2 / S3-compatible)
 *   - AsyncResolutionLedger → iq-ledger.ts    (IQLabs on-chain signed table rows)
 *
 * resolveAsync() is the remote twin of resolve(): HIT replays the cached pointer, MISS
 * recomputes + stores the blob + appends a signed resolution row. Pure over the injected
 * store + ledger, so both adapters are fully testable with stub clients (no network).
 */
import type { Pointer, Resolution, ResolutionRecord } from "./resolution-ledger.js";
// One source of truth (commandment #1/#6): the content-addressing + hash-chain core,
// imported for local use AND re-exported so existing importers (iq-ledger, standards,
// tier, tests) keep working unchanged.
import { GENESIS, sha256hex, contentPointer, intentKey, recordHash } from "./content-address.js";
export { GENESIS, contentPointer, intentKey, recordHash };

/** A content-addressed object store reachable over the network (R2 / EmergentDB). */
export interface AsyncBlobStore {
  get(hex: string): Promise<string | undefined>;
  put(hex: string, text: string): Promise<void>;
}

/** An append-only, signed ledger of resolutions that preserves PAST values. */
export interface AsyncResolutionLedger {
  /** the latest resolution for an intent, or undefined. */
  find(intent: Pointer): Promise<ResolutionRecord | undefined>;
  /** every past resolution for an intent, oldest→newest (the signed history). */
  history(intent: Pointer): Promise<ResolutionRecord[]>;
  /** append a new signed resolution row; returns the row (with its signature). */
  append(intent: Pointer, result: Pointer, ts?: number): Promise<ResolutionRecord>;
}

/** Store a value content-addressed; return its pointer. */
export async function putBlobAsync(text: string, store: AsyncBlobStore): Promise<Pointer> {
  const hex = sha256hex(text);
  await store.put(hex, text);
  return `sha256:${hex}`;
}

/** Resolve a content pointer back to its value (or null if absent / non-content scheme). */
export async function resolvePointerAsync(p: Pointer, store: AsyncBlobStore): Promise<string | null> {
  const i = p.indexOf(":");
  if (i < 0) return null;
  if (p.slice(0, i) !== "sha256") return p.slice(i + 1) || null;
  return (await store.get(p.slice(i + 1))) ?? null;
}

/**
 * Remote resolve: a fresh ledger hit replays the pointer from the blob store (no
 * recompute); a miss (or a blob evicted from the store) recomputes, stores the blob
 * content-addressed, and appends a signed resolution row. TTL'd via opts.
 */
export async function resolveAsync(
  intent: string,
  recompute: (intent: string) => Promise<string> | string,
  store: AsyncBlobStore,
  ledger: AsyncResolutionLedger,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<Resolution> {
  const now = opts.now ?? Date.now();
  const key = intentKey(intent);
  const hit = await ledger.find(key);
  const fresh = hit ? (opts.ttlMs == null || hit.ts == null || now - hit.ts <= opts.ttlMs) : false;
  if (hit && fresh) {
    const value = await resolvePointerAsync(hit.result, store);
    if (value !== null) return { value, pointer: hit.result, cached: true, recomputed: false };
  }
  const value = await recompute(intent);
  const pointer = await putBlobAsync(value, store);
  if (!hit || hit.result !== pointer || !fresh) await ledger.append(key, pointer, now);
  return { value, pointer, cached: false, recomputed: true };
}
