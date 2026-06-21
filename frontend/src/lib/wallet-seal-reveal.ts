/**
 * wallet-seal-reveal — the BROWSER half of crypto-was-all-you-needed: a value sealed to a
 * wallet (server-side via @iqlabs-official/solana-sdk `sealForWallet`) is rendered ONLY in
 * the browser, by the bound wallet, NEVER on a server. The plaintext never leaves the client
 * (render-without-seeing): the server serves an opaque sealed envelope it cannot read.
 *
 * This mirrors the IQ SDK's scheme EXACTLY (so a server-sealed envelope decrypts here):
 *   deriveX25519Keypair: sign "iq-sdk-derive-encryption-key-v1" → HKDF-SHA256 → x25519 privKey
 *   dhDecrypt:           x25519 shared secret → HKDF-SHA256 → AES-256-GCM decrypt
 * Pure Web Crypto (HKDF + AES-GCM) + @noble/curves (x25519) — the same primitives the SDK uses,
 * so the bytes are identical. Cross-compatibility is witnessed in wallet-seal-reveal.test.ts.
 */
import { x25519 } from "@noble/curves/ed25519.js";

// Protocol constants — MUST match @iqlabs-official/solana-sdk crypto/dh.js verbatim, or
// a server-sealed envelope will not decrypt. These are domain-separation tags, not secrets.
const KEY_DERIVE_MSG = "iq-sdk-derive-encryption-key-v1";
const KEY_DERIVE_SALT = "iq-sdk-x25519-v1";
const KEY_DERIVE_INFO = "x25519-private-key";
const DH_HKDF_SALT = "iq-sdk-dh-aes-v1";
const DH_HKDF_INFO = "aes-256-gcm-key";

/** A wallet's ed25519 detached-signature function — the only authority a reveal needs. */
export type SignMessage = (msg: Uint8Array) => Promise<Uint8Array>;

/** The opaque sealed envelope (as produced by the server-side sealForWallet). */
export interface SealedEnvelope {
  senderPub: string;
  iv: string;
  ciphertext: string;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Web Crypto API unavailable (needs a browser or Node 18+)");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(u: Uint8Array): string {
  return Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** HKDF-SHA256 → 32 bytes, identical to the SDK's hkdfDerive. */
async function hkdf(ikm: Uint8Array, salt: string, info: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await subtle().importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: ab(enc.encode(salt)), info: ab(enc.encode(info)) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Derive the wallet's deterministic X25519 private key from its signature (browser-side). */
export async function deriveX25519Privkey(signMessage: SignMessage): Promise<Uint8Array> {
  const sig = await signMessage(new TextEncoder().encode(KEY_DERIVE_MSG));
  return hkdf(sig, KEY_DERIVE_SALT, KEY_DERIVE_INFO);
}

/** The wallet's X25519 public key — the address a value is sealed TO. */
export async function deriveX25519Pubkey(signMessage: SignMessage): Promise<Uint8Array> {
  return x25519.getPublicKey(await deriveX25519Privkey(signMessage));
}

/**
 * Seal a value TO a wallet's X25519 public key (the dhEncrypt side, mirroring the SDK). In
 * production this happens SERVER-SIDE; exposed here only so a self-contained demo can seal +
 * reveal in one browser without a backend. Ephemeral sender key + AES-256-GCM, same scheme.
 */
export async function sealToPubkey(recipientPub: Uint8Array, value: string): Promise<SealedEnvelope> {
  const senderPriv = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const senderPub = x25519.getPublicKey(senderPriv);
  const shared = x25519.getSharedSecret(senderPriv, recipientPub);
  const aesKey = await hkdf(shared, DH_HKDF_SALT, DH_HKDF_INFO);
  const key = await subtle().importKey("raw", ab(aesKey), "AES-GCM", false, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(new TextEncoder().encode(value)));
  return { senderPub: bytesToHex(senderPub), iv: bytesToHex(iv), ciphertext: bytesToHex(new Uint8Array(ct)) };
}

/** Reveal a sealed envelope with an already-derived X25519 private key. */
export async function revealWithPrivkey(privKey: Uint8Array, env: SealedEnvelope): Promise<string> {
  const shared = x25519.getSharedSecret(privKey, hexToBytes(env.senderPub));
  const aesKey = await hkdf(shared, DH_HKDF_SALT, DH_HKDF_INFO);
  const key = await subtle().importKey("raw", ab(aesKey), "AES-GCM", false, ["decrypt"]);
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: ab(hexToBytes(env.iv)) }, key, ab(hexToBytes(env.ciphertext)));
  return new TextDecoder().decode(new Uint8Array(plain));
}

/** Render a sealed value in the browser — succeeds ONLY for the wallet it was sealed to.
 *  Throws (AES-GCM auth-tag failure) for any other wallet; the plaintext never reaches a server. */
export async function revealForWallet(signMessage: SignMessage, env: SealedEnvelope): Promise<string> {
  const privKey = await deriveX25519Privkey(signMessage);
  return revealWithPrivkey(privKey, env);
}
