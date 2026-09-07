/**
 * cred-binding — wallet-bound credential commitments, standard crypto only.
 *
 * Replaces the former Schnorr/MODP NIZK ("zk-binding") with plain Ed25519,
 * keeping the SAME privacy invariants — the credential never leaves the device,
 * a verifier learns only "yes, bound":
 *
 *   seed = SHA-256("cred:" || credential)   — one-way; reveals nothing of the credential
 *   (sk, pk) = Ed25519 keypair from seed    — pk is the public commitment `y`
 *   The WALLET signs y (Ed25519)            — "this commitment belongs to this wallet"
 *   Proof of knowledge, bound to ctx        — Ed25519 signature by the credential-derived
 *       key over "unbrowse:pok:v2|" || ctx; anyone can verify it against y, nobody can
 *       forge it without the credential.
 *
 * Privacy is unchanged in practice: the old NIZK also derived its secret as
 * H(credential), so both schemes are exactly as one-way as SHA-256. What is
 * removed is the zero-knowledge machinery (2048-bit MODP group, Schnorr /
 * Fiat-Shamir bigint algebra), not any user privacy.
 */
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { sha256hex } from "./content-address.js";
import { signBytes } from "./signer.js";

/** Public binding: commitment y (derived pubkey hex), wallet pubkey hex, wallet sig hex. */
export interface Binding { y: string; root: string; sig: string }
/** Proof of knowledge: derived-key signature (hex) over the POK message for ctx (hex). */
export interface Proof { sig: string; ctx: string }

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

// Ed25519 PKCS8 DER prefix (16 bytes) + 32-byte seed = an importable private key.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
// Ed25519 SPKI DER prefix (12 bytes) + 32-byte raw pubkey = a verifiable key.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Domain-separated message the derived key signs: binds the proof to ctx. */
export function pokMessage(ctx: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from("unbrowse:pok:v2|"), Buffer.from(ctx)]);
}

/** seed = SHA-256("cred:" || credential) — one-way; never transmitted. */
function credentialSeed(credential: Uint8Array): Buffer {
  return Buffer.from(
    sha256hex(Buffer.concat([Buffer.from("cred:"), Buffer.from(credential)])),
    "hex",
  );
}

function derivedPrivateKey(credential: Uint8Array) {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, credentialSeed(credential)]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** y — the public commitment: the Ed25519 pubkey derived from the credential (hex). */
export function bindingPubkey(credential: Uint8Array): string {
  const priv = derivedPrivateKey(credential);
  // node accepts a private KeyObject here (returns its public half); the @types
  // overloads don't model that — same runtime path wallet-hierarchy uses.
  const pub = createPublicKey(priv as unknown as Parameters<typeof createPublicKey>[0]);
  const spki = pub.export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(spki.length - 32).toString("hex");
}

/** A modern binding point is a raw Ed25519 pubkey (64 hex chars). Legacy MODP
 *  points from the retired zk scheme are ~512 hex chars (attestation-only now). */
export function isProvableBindingPoint(y: string): boolean {
  return /^[0-9a-f]{64}$/i.test(y);
}

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

/** Bind a credential to THIS wallet: publish y (derived pubkey) and the wallet's
 *  signature over y. Reveals nothing of the credential. */
export async function bind(credential: Uint8Array): Promise<Binding> {
  const yHex = bindingPubkey(credential);
  const { signature, walletPubkey } = await signBytes(Buffer.from(yHex, "utf8"));
  return { y: yHex, root: bytesToHex(walletPubkey), sig: bytesToHex(signature) };
}

/** Prove knowledge of the credential behind its commitment: sign the ctx-bound
 *  POK message with the derived key. The credential is never in the output. */
export function prove(credential: Uint8Array, ctx: Uint8Array = new Uint8Array()): Proof {
  const sig = nodeSign(null, Buffer.from(pokMessage(ctx)), derivedPrivateKey(credential));
  return { sig: bytesToHex(sig), ctx: bytesToHex(ctx) };
}

/** Verify a proof of knowledge against a public commitment y (hex): the prover
 *  holds the credential behind y, learnt without it being transmitted. */
export function verifyPok(yHex: string, proof: Proof): boolean {
  try {
    if (!isProvableBindingPoint(yHex)) return false;
    return verifyEd25519(
      Buffer.from(yHex, "hex"),
      pokMessage(Buffer.from(proof.ctx, "hex")),
      Buffer.from(proof.sig, "hex"),
    );
  } catch {
    return false;
  }
}

/** True iff (1) the wallet really signed this y AND (2) the proof shows knowledge
 *  of the bound credential — the credential never transmitted. */
export function verifyBinding(binding: Binding, proof: Proof): boolean {
  const root = Buffer.from(binding.root, "hex");
  const sig = Buffer.from(binding.sig, "hex");
  if (!verifyEd25519(root, Buffer.from(binding.y, "utf8"), sig)) return false;
  return verifyPok(binding.y, proof);
}

/** Entropy helper kept for callers that need a random scalar-free nonce. */
export function randomNonceHex(): string {
  return bytesToHex(randomBytes(32));
}
