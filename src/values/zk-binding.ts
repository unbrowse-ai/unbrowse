/**
 * zk-binding — production port of the whitepaper's ZK credential binding
 * (paper/reference/zk/binding.py), the CENTRAL contribution of *Internal APIs
 * Were Not All You Needed* (§4): prove that a credential (cookie, API token,
 * keychain entry) is bound to the wallet WITHOUT revealing the credential.
 *
 * Construction (a textbook, sound NIZK):
 *   x = H("cred:" || credential) mod q   — secret scalar derived from the credential
 *   y = g^x mod p   over RFC-3526 group 14 (2048-bit MODP); discrete-log hard, so y
 *                   is one-way and reveals nothing about x / the credential.
 *   The WALLET signs y (Ed25519) — "this y belongs to this wallet". The credential
 *   never appears at any layer, only the one-way y.
 *   Schnorr / Fiat-Shamir proof of knowledge of x:
 *       k random in [1,q);  t = g^k;  e = H(g|y|t|ctx) mod q;  s = k + e*x mod q
 *   Verifier checks  g^s == t * y^e (mod p)  AND the wallet's signature over y.
 *
 * A holder who knows the credential proves it is the one bound to the wallet; a
 * verifier learns only "yes, bound" — never the credential. Tamper with y, the
 * proof, or the wallet, and verification fails (fails closed; no fabricated bind).
 */
import { createPublicKey, randomBytes, verify as nodeVerify } from "node:crypto";
import { sha256hex } from "./content-address.js";
import { signBytes } from "./signer.js";

// RFC 3526 group 14 (2048-bit MODP). p safe prime, q=(p-1)/2, generator g=2.
const P = BigInt("0x" +
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
  "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
  "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05" +
  "98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB" +
  "9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
  "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718" +
  "3995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF");
const G = 2n;
const Q = (P - 1n) / 2n;

export interface Binding { y: string; root: string; sig: string }   // y, wallet pubkey hex, sig hex
export interface Proof { t: string; s: string; ctx: string }        // Schnorr proof (hex)

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function sha256Big(data: Uint8Array): bigint {
  return BigInt("0x" + sha256hex(data));
}

const hex = (b: bigint): string => b.toString(16);
const unhex = (s: string): bigint => BigInt("0x" + s);
const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** x = H("cred:" || credential) mod q — the secret scalar; never transmitted. */
export function credentialScalar(credential: Uint8Array): bigint {
  return sha256Big(Buffer.concat([Buffer.from("cred:"), Buffer.from(credential)])) % Q;
}

/** y = g^x mod p — the public, one-way binding point. */
export function bindingPoint(credential: Uint8Array): bigint {
  return modpow(G, credentialScalar(credential), P);
}

function challenge(y: bigint, t: bigint, ctx: Uint8Array): bigint {
  return sha256Big(Buffer.concat([Buffer.from(`${G}|${y}|${t}|`), Buffer.from(ctx)])) % Q;
}

function randomScalar(): bigint {
  // ample entropy then reduce into [1, q-1] (bias negligible at +256 bits)
  const r = sha256Big(randomBytes(64)) * sha256Big(randomBytes(64));
  return (r % (Q - 1n)) + 1n;
}

/** Schnorr/Fiat-Shamir proof of knowledge of the credential behind its binding
 *  point — emits {t,s,ctx}; the credential and x are never in the output. */
export function prove(credential: Uint8Array, ctx: Uint8Array = new Uint8Array()): Proof {
  const x = credentialScalar(credential);
  const y = modpow(G, x, P);
  const k = randomScalar();
  const t = modpow(G, k, P);
  const e = challenge(y, t, ctx);
  const s = (k + e * x) % Q;
  return { t: hex(t), s: hex(s), ctx: bytesToHex(ctx) };
}

/** Verify the Schnorr proof against a public binding point y (hex): the prover
 *  knows the credential behind y, learnt without it being transmitted. */
export function verifySchnorr(yHex: string, proof: Proof): boolean {
  try {
    const y = unhex(yHex);
    const t = unhex(proof.t);
    const s = unhex(proof.s);
    const ctx = Buffer.from(proof.ctx, "hex");
    const e = challenge(y, t, ctx);
    return modpow(G, s, P) === (t * modpow(y, e, P)) % P;   // g^s == t * y^e
  } catch {
    return false;
  }
}

// Ed25519 SPKI DER prefix (12 bytes) + 32-byte raw pubkey = a verifiable key.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** Verify an Ed25519 signature from a raw 32-byte pubkey (shared by signed-descent). */
export function verifyEd25519(pubkeyRaw: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    const spki = Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(pubkeyRaw)]);
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    return nodeVerify(null, Buffer.from(message), pub, Buffer.from(sig));
  } catch {
    return false;
  }
}

/** Bind a credential to THIS wallet: publish y = g^x and the wallet's signature
 *  over y. Reveals nothing of the credential. */
export async function bind(credential: Uint8Array): Promise<Binding> {
  const yHex = hex(bindingPoint(credential));
  const { signature, walletPubkey } = await signBytes(Buffer.from(yHex, "utf8"));
  return { y: yHex, root: bytesToHex(walletPubkey), sig: bytesToHex(signature) };
}

/** True iff (1) the wallet really signed this y AND (2) the Schnorr proof shows
 *  knowledge of the bound credential — the credential never transmitted. */
export function verifyBinding(binding: Binding, proof: Proof): boolean {
  const root = Buffer.from(binding.root, "hex");
  const sig = Buffer.from(binding.sig, "hex");
  if (!verifyEd25519(root, Buffer.from(binding.y, "utf8"), sig)) return false;
  return verifySchnorr(binding.y, proof);
}
