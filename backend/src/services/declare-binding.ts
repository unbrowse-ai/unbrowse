/**
 * Credential-binding verification — backend leg of values/cred-binding.ts.
 *
 * The scheme (standard crypto only; replaces the retired Schnorr/MODP NIZK):
 *
 *   - The client derives an Ed25519 keypair one-way from the credential bytes
 *     (seed = SHA-256("cred:"||credential)); the pubkey is the public
 *     commitment `y`. The credential never appears — only y, which is one-way.
 *   - The WALLET signs y (ed25519), binding "this y belongs to this wallet".
 *   - Proof of knowledge, bound to ctx: an ed25519 signature by the derived key
 *     over "unbrowse:pok:v2|" || ctx — verifiable against y, unforgeable
 *     without the credential.
 *
 * The backend only VERIFIES (two ordinary Ed25519 checks, Web Crypto — the same
 * path declare-signature.ts uses); bind/prove live client-side in
 * src/values/cred-binding.ts. A verifier learns only "yes, bound" — never the
 * credential. Same privacy, no zero-knowledge machinery.
 */

const enc = new TextEncoder();

/** Public binding produced by the client — y signed by the wallet over utf8(y_hex). */
export interface CredBinding {
  /** Credential-derived Ed25519 pubkey, hex (64 chars) — the one-way commitment. */
  y: string;
  /** Wallet ed25519 pubkey (hex) that signed y. */
  root: string;
  /** ed25519 signature (hex) over utf8(y). */
  sig: string;
}

/** Proof of knowledge of the credential behind a binding. */
export interface CredProof {
  /** ed25519 signature (hex) by the derived key over the ctx-bound POK message. */
  sig: string;
  /** Context bytes, hex — the statement this proof is bound to. */
  ctx: string;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Domain-separated POK message — MUST match src/values/cred-binding.ts. */
function pokMessage(ctx: Uint8Array): Uint8Array {
  const prefix = enc.encode("unbrowse:pok:v2|");
  const msg = new Uint8Array(prefix.length + ctx.length);
  msg.set(prefix, 0);
  msg.set(ctx, prefix.length);
  return msg;
}

/** ed25519 verify — same Web Crypto path declare-signature.ts uses. */
async function verifyRawEd25519(
  pubHex: string,
  sigHex: string,
  msg: Uint8Array,
): Promise<boolean> {
  try {
    const pubBytes = hexToBytes(pubHex);
    if (pubBytes.length !== 32) return false;
    const sigBytes = hexToBytes(sigHex);
    if (sigBytes.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      pubBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, msg);
  } catch {
    return false;
  }
}

/**
 * Verify a credential binding + proof. Two independent legs, BOTH must hold:
 *
 *   1. wallet-sig leg — the wallet really bound this y (ed25519 verify over
 *      utf8(y_hex) against `root`).
 *   2. knowledge leg — the prover holds the credential behind y (ed25519 verify
 *      of the ctx-bound POK message against y itself).
 *
 * Fails closed on any malformed input.
 */
export async function verifyBinding(binding: CredBinding, proof: CredProof): Promise<boolean> {
  try {
    if (!/^[0-9a-f]{64}$/i.test(binding.y)) return false;
    if (!(await verifyRawEd25519(binding.root, binding.sig, enc.encode(binding.y)))) {
      return false;
    }
    return await verifyRawEd25519(binding.y, proof.sig, pokMessage(hexToBytes(proof.ctx)));
  } catch {
    return false;
  }
}
