/**
 * zk-bound-hole — the integration node that makes a hole's wallet-binding REAL with
 * the ZK credential-binding primitive (values/zk-binding.ts). The hole-template's
 * `bound` field was a placeholder commitment; here it carries an actual binding
 * {y, root, sig} where y = g^x over the MODP group (one-way; the secret never
 * appears) and the wallet has signed y.
 *
 * Three parties, three checks, no secret transmitted:
 *   - bindHole(hole, secret): the client attaches the binding to the hole.
 *   - verifyHoleAttested(hole): the BACKEND confirms the wallet really bound this
 *     slot (Ed25519 sig over y) — without the secret and without a proof.
 *   - proveHole / verifyHoleProof: at fill time the HOLDER proves it knows the bound
 *     secret (Schnorr NIZK); the verifier learns only "yes, bound", never the secret.
 *
 * "Map PII to keys/values privately, ZK'd to the wallet" — at the hole boundary,
 * auditable end to end.
 */
import { bind, prove, verifyBinding, verifyEd25519, type Binding, type Proof } from "../values/zk-binding.js";
import type { Hole } from "./hole-template.js";

const TAG = "zkbind:";

/** Serialise a binding into the hole's `bound` string (no secret in it). */
export function boundTag(b: Binding): string {
  return `${TAG}${b.y}.${b.root}.${b.sig}`;
}

/** Parse a `bound` tag back to a binding, or null if it is not a zk binding. */
export function parseBoundTag(tag: string | undefined): Binding | null {
  if (!tag || !tag.startsWith(TAG)) return null;
  const [y, root, sig] = tag.slice(TAG.length).split(".");
  return y && root && sig ? { y, root, sig } : null;
}

/** Client: attach a real ZK wallet-binding to a secret hole. Reveals nothing of
 *  the secret — only the one-way point y and the wallet's signature over it. */
export async function bindHole(hole: Hole, secret: Uint8Array): Promise<Hole> {
  return { ...hole, bound: boundTag(await bind(secret)) };
}

/** Backend: confirm the wallet really bound this slot (signed y) — checkable with
 *  NO secret and NO proof. Rejects an unbound or forged-signature hole. */
export function verifyHoleAttested(hole: Hole): boolean {
  const b = parseBoundTag(hole.bound);
  if (!b) return false;
  try {
    return verifyEd25519(Buffer.from(b.root, "hex"), Buffer.from(b.y, "utf8"), Buffer.from(b.sig, "hex"));
  } catch {
    return false;
  }
}

/** Holder: prove knowledge of the secret bound to this hole (Schnorr NIZK). */
export function proveHole(secret: Uint8Array, ctx: Uint8Array = new Uint8Array()): Proof {
  return prove(secret, ctx);
}

/** Verifier: the hole is wallet-bound AND the prover holds the bound secret —
 *  the secret never transmitted. */
export function verifyHoleProof(hole: Hole, proof: Proof): boolean {
  const b = parseBoundTag(hole.bound);
  return b ? verifyBinding(b, proof) : false;
}
