/**
 * content-address — the ONE source of truth for the content-addressing + hash-chain
 * core (invariant #1 "one root", #6 "no-duplication/DRY"). GENESIS, the sha256
 * primitive, the `sha256:<hex>` pointer shape, and the canonical record hash were
 * re-implemented across resolution-ledger / async-resolution / sealed-ledger /
 * signed-descent / layer-wallet-descent. They live here once; everyone imports.
 *
 * Cited shape: Merkle / IPFS content-addressing + the Certificate-Transparency /
 * Nakamoto append-only hash chain (RFC 6962, Bitcoin 2008).
 */
import { createHash } from "node:crypto";

/** A pointer is `scheme:addr` — sha256:<hex> for content, or any self-identifying URI. */
export type Pointer = string;

/** Genesis hash — the chain's prev-of-first-row. */
export const GENESIS = "0".repeat(64);

/** sha256 hex of a string OR raw bytes — the one hash primitive. */
export const sha256hex = (s: string | Uint8Array): string =>
  createHash("sha256").update(typeof s === "string" ? s : Buffer.from(s)).digest("hex");

/** Content-addressed pointer for a value: `sha256:<hex of bytes>` (same on any host). */
export function contentPointer(text: string): Pointer {
  return `sha256:${sha256hex(text)}`;
}

/** The signature / KV key for an intent — its content-addressed pointer (namespaced
 *  apart from a raw value pointer). */
export function intentKey(intent: string): Pointer {
  return `sha256:${sha256hex(`intent ${intent}`)}`;
}

/** Canonical hash of a ledger record's signed core. Key order intent,prev,result,seq is
 *  fixed (NOT sorted) — every chain that links rows must agree on it. */
export function recordHash(rec: { intent: string; prev: string; result: Pointer; seq: number }): string {
  return sha256hex(JSON.stringify({ intent: rec.intent, prev: rec.prev, result: rec.result, seq: rec.seq }));
}
