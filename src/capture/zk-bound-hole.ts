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
import { bindSecretToWallet } from "./wallet-bind.js";
import type { Hole } from "./hole-template.js";

const TAG = "zkbind:";

/**
 * Map of `sha16 → real ZK binding`, keyed by the SAME 16-hex tag the redactor
 * stamps into the obfuscated capture (`[bound:<sha16>]`, see wallet-bind.ts
 * `bindingTag`). This is the out-of-band channel that carries the real binding
 * from the one place the secret is live (obfuscation, Seam 2) to hole
 * construction (Seam 1), without ever putting the long `{y,root,sig}` inline on
 * the wire or routing an async `bind()` through the sync redactor.
 */
export type BindingMap = Record<string, Binding>;

/** Proofs the holder generates at fill time, keyed by hole name (Seam 3). */
export type HoleProofs = Record<string, Proof>;

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

/**
 * Seam 2 (the binding mint): at obfuscation time — the ONE place the plaintext
 * secrets are live — mint a real ZK binding for each, keyed by the same `sha16`
 * the redactor stamps (`bindingTag` → `[bound:<sha16>]`). The secret bytes never
 * leave: only `{y,root,sig}` (one-way point + wallet signature) enter the map.
 * The result rides out-of-band to hole construction (Seam 1), where it upgrades
 * each matching `Hole.bound` from the bare commitment to the real `zkbind:` tag,
 * reviving the already-wired backend `verifyHoleAttested` check.
 *
 * `walletPubkey` MUST be the same wallet the ambient signer (`bind`) uses, so the
 * commitment key and the binding's `root` agree — pass the capture wallet pubkey.
 */
export async function zkBindKnownSecrets(secrets: string[], walletPubkey: string): Promise<BindingMap> {
  const map: BindingMap = {};
  const enc = new TextEncoder();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    const sha16 = bindSecretToWallet(secret, walletPubkey).slice(0, 16);
    if (map[sha16]) continue; // same secret already bound this pass
    map[sha16] = await bind(enc.encode(secret));
  }
  return map;
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

/**
 * Seam 3 (fill boundary) — at fill time, for every hole carrying a REAL ZK
 * binding (`zkbind:`), the holder proves knowledge of the value it is filling in
 * (`fills[hole.name]`, the exact bound string). Holes without a real binding
 * (plain `[REDACTED]`/commitment, or LLM-sourced ids) need no proof and are
 * skipped. The returned proofs ride to the backend ALONGSIDE the sealed fills —
 * they carry no secret bytes (Schnorr NIZK), only `{t,s,ctx}`.
 */
export function proveHoles(holes: Hole[], fills: Record<string, string>): HoleProofs {
  const enc = new TextEncoder();
  const out: HoleProofs = {};
  for (const h of holes) {
    if (!parseBoundTag(h.bound)) continue; // only real zkbind holes are provable
    const value = fills[h.name];
    if (typeof value !== "string") continue; // nothing filled here
    out[h.name] = proveHole(enc.encode(value));
  }
  return out;
}

/**
 * Backend verifier — every real-bound hole must carry a proof that verifies
 * against its binding. A bound hole with a missing or failing proof closes the
 * gate (false); holes with no real binding impose no proof requirement.
 */
export function verifyHoleProofs(holes: Hole[], proofs: HoleProofs): boolean {
  for (const h of holes) {
    if (!parseBoundTag(h.bound)) continue;
    const proof = proofs[h.name];
    if (!proof || !verifyHoleProof(h, proof)) return false;
  }
  return true;
}
