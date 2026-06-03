/**
 * sealed-cache — the production port of the whitepaper's sealed-unless-revealed
 * primitive (paper/reference/ledger/sealed_cache.py), the privacy half of
 * *Internal APIs Were Not All You Needed* (§5).
 *
 * A value is content-addressed by sha256 of its PLAINTEXT (so the same content
 * resolves to the same key on any host — the content-addressing the plain cache
 * already has), but the bytes AT REST are AES-256-GCM ciphertext under a key
 * bound to the wallet (`deriveSealKey()` in signer.ts — HKDF over the Ed25519
 * seed). The at-rest bytes are unreadable; only the holder of the wallet can
 * `revealValue`. A different wallet's key fails the GCM auth tag and the value
 * stays sealed (no fabricated reveal). The AAD is the content hash, so a
 * ciphertext cannot be relabelled under a different key.
 *
 * This moves the paper's central [proposed] contribution one rung toward
 * [shipped]: "any key/value can be sealed to the wallet, only the holder opens
 * it." It is the floor under ZK credential binding — the same shape, with the
 * commitment proof layered on next.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** sha256(plaintext) hex — the content address; identical bytes → identical key
 *  on any host (the property the seal must preserve). */
export function contentHash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Thrown when a reveal is attempted by a wallet that does not hold the seal key,
 *  or when the revealed plaintext fails its content-hash check. */
export class SealReveal extends Error {}

const NONCE_LEN = 12;
const TAG_LEN = 16;

/**
 * Seal `data` under the 32-byte `key`. Returns the content hash (over the
 * PLAINTEXT) and the sealed blob `nonce(12) || ciphertext || tag(16)`. The AAD is
 * the content hash, binding the ciphertext to its label.
 */
export function sealValue(data: Uint8Array, key: Uint8Array): { hash: string; sealed: Uint8Array } {
  if (key.length !== 32) throw new Error("seal key must be 32 bytes (AES-256)");
  const hash = contentHash(data);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(hash, "utf8"));
  const ct = Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { hash, sealed: new Uint8Array(Buffer.concat([nonce, ct, tag])) };
}

/**
 * Reveal a sealed blob under `key`. The wrong wallet's key fails the GCM auth tag
 * → SealReveal (the value STAYS sealed; nothing fabricated). A tampered ciphertext
 * fails the tag too; a tampered hash label fails the AAD check or the final
 * content-hash re-derivation.
 */
export function revealValue(hash: string, sealed: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new Error("seal key must be 32 bytes (AES-256)");
  const buf = Buffer.from(sealed);
  if (buf.length < NONCE_LEN + TAG_LEN) throw new SealReveal("sealed blob too short");
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(hash, "utf8"));
  decipher.setAuthTag(tag);
  let pt: Buffer;
  try {
    pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new SealReveal(`reveal denied: wallet does not hold the seal key for ${hash.slice(0, 8)}`);
  }
  // The seal re-derives the address; a content/hash mismatch is caught here too.
  if (contentHash(new Uint8Array(pt)) !== hash) {
    throw new SealReveal("revealed plaintext does not match content hash");
  }
  return new Uint8Array(pt);
}
