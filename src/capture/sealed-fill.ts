/**
 * sealed-fill — the integration node that joins the hole-exposure flow
 * (hole-template.ts: the backend surfaces ONLY the slots to fill, never a secret)
 * to the wallet seal (values/wallet-seal.ts: a value sealed to the wallet, opened
 * only by its holder). This is the whitepaper's privacy promise made concrete in
 * the client flow:
 *
 *   - The client keeps its fill values (auth, secrets) SEALED to its wallet, not in
 *     the clear — `sealFills`. The at-rest fills leak nothing.
 *   - At the moment of emitting the concrete request, the client REVEALS them
 *     LOCALLY (only the wallet holder's key can) and fills the exposed holes —
 *     `fillHolesSealed`. A non-holder's key fails to reveal, so no one but the
 *     wallet owner can complete the request, and the backend never sees a plaintext
 *     secret at any point.
 *
 * "Any key/value ZK'd to the wallet, only for them to use" — at the hole boundary.
 */
import { sealValue, revealValue } from "../values/wallet-seal.js";
import { fillHoles, type HoleTemplate } from "./hole-template.js";
import type { RawRequest } from "./index.js";

export interface SealedFill { hash: string; sealed: Uint8Array }

/** Seal each fill value to the wallet key. The returned blobs are ciphertext — safe
 *  to cache/persist; only the wallet holder can reveal them. */
export function sealFills(fills: Record<string, string>, key: Uint8Array): Record<string, SealedFill> {
  const out: Record<string, SealedFill> = {};
  const te = new TextEncoder();
  for (const [name, value] of Object.entries(fills)) {
    out[name] = sealValue(te.encode(value), key);
  }
  return out;
}

/** Reveal the sealed fills LOCALLY (only the wallet holder) and fill the exposed
 *  holes into a concrete request. A wrong key throws SealReveal — the request
 *  cannot be completed by anyone but the wallet owner. The backend never sees a
 *  plaintext secret; it only ever produced the hole names. */
export function fillHolesSealed(
  template: HoleTemplate,
  sealedFills: Record<string, SealedFill>,
  key: Uint8Array,
): RawRequest {
  const td = new TextDecoder();
  const fills: Record<string, string> = {};
  for (const [name, sf] of Object.entries(sealedFills)) {
    fills[name] = td.decode(revealValue(sf.hash, sf.sealed, key)); // throws on wrong key
  }
  return fillHoles(template, fills);
}
