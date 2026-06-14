/**
 * Ed25519 signer for v7.0 fill receipts.
 *
 * Substrate: ZK_SCOPE §"v7.0 (sig-shape)". v7.0 ships a plain Ed25519
 * signature over `canonicalJSON({pointer, nonce, contextHash, commitment})`
 * made with the x402-wallet-bound key stored in the OS keychain. The signed
 * fragment exactly matches `canonicalizeSignedFragment` in
 * `backend/src/services/audit.ts` so the server-side verify path
 * round-trips. The SNARK (Groth16) swaps in for v7.3 BEHIND THIS EXACT
 * SURFACE — the signer's `sign()` return shape does not change.
 *
 * Bootstrap (Gen 1:3 — "let there be light", first mint of the wallet key):
 *  - macOS: `security add-generic-password -s unbrowse-x402-wallet
 *           -a default -w <hex(privkey)> -U` (-U upserts if absent).
 *  - linux/other: encrypted file fallback at `~/.unbrowse/wallet.enc`,
 *    AES-256-GCM, key derived from `UNBROWSE_WALLET_PASSPHRASE` env (or a
 *    machine-stable salt if absent; this is documented best-effort).
 *  - Idempotent: on every getWalletPubkey()/sign() we first check the
 *    store for an existing key. Mint ONLY if absent.
 *
 * Mt 6:6 — "shut thy door, and pray to thy Father which is in secret": the
 * privkey lives in the OS-protected store, never in process memory longer
 * than one sign() call.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  generateKeyPairSync,
  createDecipheriv,
  scryptSync,
  hkdfSync,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { AdapterError } from "./types.js";
import { safeZero } from "./memzero.js";
import { getSecret, setSecret, type SecretStoreOptions } from "./keychain.js";

/** Output of `sign()`. Both fields are safe to log. */
export interface Signature {
  /** 64-byte Ed25519 signature. */
  readonly signature: Uint8Array;
  /** 32-byte Ed25519 pubkey. */
  readonly walletPubkey: Uint8Array;
}

const KEYCHAIN_SERVICE = "unbrowse-x402-wallet";
const KEYCHAIN_ACCOUNT = "default";

// All wallet paths resolve LAZILY (per call) so an isolated runtime — a test, a
// profile, a sandbox — can point the wallet elsewhere via env WITHOUT touching
// the real ~/.unbrowse or the real macOS keychain. Precedence:
//   UNBROWSE_WALLET_DIR  (wallet-only override; tests use this)
//   UNBROWSE_CONFIG_DIR  (shared with the config system; profiles use this)
//   ~/.unbrowse          (default install)
// Production sets neither, so behaviour is byte-for-byte unchanged.
function walletDir(): string {
  const w = process.env.UNBROWSE_WALLET_DIR?.trim();
  if (w) return w;
  const c = process.env.UNBROWSE_CONFIG_DIR?.trim();
  if (c) return c;
  return join(homedir(), ".unbrowse");
}
function walletEncPath(): string {
  return join(walletDir(), "wallet.enc");
}
// The OS secret store is the DEFAULT-install identity store (one slot:
// unbrowse-x402-wallet/default). It is bypassed whenever the wallet is isolated
// to a non-default directory (UNBROWSE_WALLET_DIR — tests) or explicitly
// disabled (UNBROWSE_DISABLE_KEYCHAIN=1) — see secretStoreOpts() — so an
// isolated run can NEVER read or overwrite the real user's key. Kept as a
// diagnostic predicate (exported via __internal): true when the real macOS
// keychain is the active backend.
function keychainEnabled(): boolean {
  if (!isDarwin()) return false;
  if (process.env.UNBROWSE_WALLET_DIR?.trim()) return false;
  if (process.env.UNBROWSE_DISABLE_KEYCHAIN === "1") return false;
  return true;
}

// Cache the pubkey for the lifetime of the process so getWalletPubkey() is
// O(1) after the first call. The PRIVKEY is NEVER cached — every sign()
// re-reads it from the store, uses it within a try/finally, and zeros the
// buffer on exit.
let pubkeyCache: Uint8Array | null = null;

// ─── Storage backend ────────────────────────────────────────────────────────

function isDarwin(): boolean {
  return platform() === "darwin";
}

// Legacy file decryption — ONLY for migrating a pre-keychain.ts wallet.enc
// (raw 32 seed bytes, scrypt salt "…-v7") into the unified store. New writes
// go through keychain.ts; this reader exists so an existing non-macOS wallet
// is never orphaned by the move.
function deriveLegacyFileKey(): Buffer {
  const passphrase = process.env.UNBROWSE_WALLET_PASSPHRASE ?? `unbrowse:${homedir()}`;
  return scryptSync(passphrase, "unbrowse-x402-wallet-v7", 32);
}

function readLegacyFile(): Uint8Array | null {
  const filePath = walletEncPath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath);
    // [12 iv][16 tag][ciphertext]
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", deriveLegacyFileKey(), iv);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
  } catch {
    return null;
  }
}

// Where the unified secret store should keep this wallet. An isolated run (a
// test via UNBROWSE_WALLET_DIR, an explicit UNBROWSE_DISABLE_KEYCHAIN) must
// NEVER read or overwrite the real user's OS-keychain key, so it is pinned to
// the encrypted-file backend at the isolated dir. Otherwise the
// platform-native backend handles it (macOS keychain / Linux secret-service /
// Windows DPAPI) — the no-password, OS-agnostic path.
function secretStoreOpts(): SecretStoreOptions {
  const isolated =
    !!process.env.UNBROWSE_WALLET_DIR?.trim() ||
    process.env.UNBROWSE_DISABLE_KEYCHAIN === "1";
  return isolated
    ? { forceBackend: "encrypted-file", fallbackDir: walletDir() }
    : { fallbackDir: walletDir() };
}

function loadPrivkey(): Uint8Array | null {
  // 1. The unified store. On macOS this reads the SAME keychain item the old
  //    signer wrote (service/account + hex encoding unchanged), so existing
  //    macOS wallets carry over with zero migration.
  const hex = getSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, secretStoreOpts());
  if (hex && /^[0-9a-fA-F]+$/.test(hex) && hex.length > 0) {
    return hexToBytes(hex);
  }
  // 2. Migration: a pre-keychain.ts wallet.enc (non-macOS / file fallback).
  //    Decrypt it with the legacy key, re-persist into the unified store so the
  //    next load is native, and return it — an existing wallet is never lost.
  const legacy = readLegacyFile();
  if (legacy) {
    try { persistPrivkey(legacy); } catch { /* best-effort; the legacy file stays the source */ }
    return legacy;
  }
  return null;
}

function persistPrivkey(privkey: Uint8Array): void {
  // ONE store (the unified keychain), hex-encoded — no drift between backends.
  if (setSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, bytesToHex(privkey), secretStoreOpts())) {
    return;
  }
  throw new AdapterError(
    "adapter_unavailable",
    "could not persist wallet key (OS secret store + encrypted-file fallback both failed)",
    isDarwin()
      ? "check `security` binary permissions and ~/.unbrowse/ writability"
      : "ensure secret-tool/libsecret (Linux) is installed, or ~/.unbrowse/ is writable with UNBROWSE_WALLET_PASSPHRASE set",
  );
}

// ─── Ed25519 PKCS8 helpers ──────────────────────────────────────────────────
// node:crypto's Ed25519 surface speaks PKCS8 (DER) for private keys. We store
// 32 raw seed bytes in the keychain, and wrap into PKCS8 on demand at sign
// time. The wrapper is constant: a fixed 16-byte ASN.1 prefix + 32 seed bytes.
//
// PKCS8 prefix for Ed25519:
//   30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20
// (SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING (OCTET STRING seed) })
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

function seedToPkcs8(seed: Uint8Array): Buffer {
  if (seed.length !== 32) {
    throw new AdapterError(
      "invalid_pointer",
      `Ed25519 seed must be 32 bytes, got ${seed.length}`,
    );
  }
  return Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
}

// SPKI prefix for Ed25519 (12 bytes), followed by 32-byte raw pubkey.
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function spkiToRawPubkey(spki: Buffer): Uint8Array {
  if (spki.length !== SPKI_ED25519_PREFIX.length + 32) {
    throw new AdapterError(
      "adapter_unavailable",
      `unexpected SPKI length: ${spki.length}`,
    );
  }
  return new Uint8Array(spki.subarray(SPKI_ED25519_PREFIX.length));
}

function privkeyToPubkey(seed: Uint8Array): Uint8Array {
  const pkcs8 = seedToPkcs8(seed);
  const privKeyObject = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const pubKeyObject = createPublicKey(privKeyObject);
  const spki = pubKeyObject.export({ format: "der", type: "spki" }) as Buffer;
  return spkiToRawPubkey(spki);
}

// ─── Bootstrap (idempotent) ─────────────────────────────────────────────────

/**
 * Ensure a wallet key exists. Reads existing key from store; mints + persists
 * if absent. Returns the (raw 32-byte) privkey seed.
 *
 * Returned buffer MUST be zeroed by caller after use. We do not cache the
 * privkey across calls.
 */
function ensureWalletKey(): Uint8Array {
  const existing = loadPrivkey();
  if (existing) return existing;

  // Mint a new Ed25519 seed. node:crypto's generateKeyPairSync gives us a
  // key object; export the seed by re-serialising to PKCS8 and slicing.
  const { privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  // The seed is the last 32 bytes of the PKCS8 blob (after the 16-byte prefix).
  if (pkcs8.length !== PKCS8_ED25519_PREFIX.length + 32) {
    throw new AdapterError(
      "adapter_unavailable",
      `unexpected PKCS8 length on generate: ${pkcs8.length}`,
    );
  }
  const seed = new Uint8Array(pkcs8.subarray(PKCS8_ED25519_PREFIX.length));
  try {
    persistPrivkey(seed);
  } catch (err) {
    safeZero(seed);
    throw err;
  }
  return seed;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ─── Public surface ─────────────────────────────────────────────────────────

/**
 * Derive a 32-byte symmetric SEAL key bound to the wallet identity — HKDF-SHA256
 * over the Ed25519 seed, domain-separated from signing so the seal key can never
 * be confused with (or reconstruct) a signature. This is the production half of
 * the whitepaper's sealed-unless-revealed cache (paper/reference/ledger/
 * sealed_cache.py): values encrypted under this key are readable ONLY by the
 * holder of this wallet — a different wallet derives a different key and the GCM
 * tag fails (no fabricated reveal).
 *
 * Same posture as sign(): the seed is loaded transiently and zeroed in `finally`;
 * the seed never lives in process memory beyond this call. The returned key is
 * the long-lived seal material — the caller should zero it after use.
 */
const SEAL_SALT = Buffer.from("unbrowse/seal/v1");
const SEAL_INFO = Buffer.from("sealed-unless-revealed");
export function deriveSealKey(): Uint8Array {
  const seed = ensureWalletKey();
  try {
    return new Uint8Array(hkdfSync("sha256", seed, SEAL_SALT, SEAL_INFO, 32));
  } finally {
    safeZero(seed);
  }
}

/**
 * Run `fn` with the raw 32-byte wallet seed loaded transiently, then zero it —
 * same posture as sign()/deriveSealKey(). Used to derive the per-layer wallet
 * ownership tree (wallet-hierarchy.ts) from the one root the user controls. `fn`
 * must NOT retain the seed; copy out only derived material (pubkeys, signatures).
 */
export function withRootSeed<T>(fn: (seed: Uint8Array) => T): T {
  const seed = ensureWalletKey();
  try {
    return fn(seed);
  } finally {
    safeZero(seed);
  }
}

/**
 * Sign the v7.0 fill receipt fragment with the x402-wallet-bound Ed25519
 * key.
 *
 * The signed bytes are `canonicalJSON({pointer, nonce, contextHash, commitment})`,
 * EXACTLY matching `canonicalizeSignedFragment` in
 * `backend/src/services/audit.ts` so the server-side verify path
 * round-trips. The caller passes the four already-computed inputs so the
 * signer does not need to know about value bytes (the commitment is the
 * cryptographic shadow of the value, computed in the adapter).
 */
export async function sign(
  pointer: string,
  nonce: Uint8Array,
  contextHash: Uint8Array,
  commitment: Uint8Array,
): Promise<Signature> {
  const seed = ensureWalletKey();
  try {
    const pkcs8 = seedToPkcs8(seed);
    const privKeyObject = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    // Build the canonical JSON fragment EXACTLY as audit.ts does.
    // Both client and server agree on the bytes signed. Key order is fixed.
    const fragment = JSON.stringify({
      pointer,
      nonce: bytesToBase64(nonce),
      contextHash: bytesToHex(contextHash),
      commitment: bytesToHex(commitment),
    });
    const data = new TextEncoder().encode(fragment);
    // node:crypto Ed25519 sign — algorithm is null per spec.
    const sigBuf = nodeSign(null, data, privKeyObject);
    const signature = new Uint8Array(sigBuf);
    const walletPubkey = privkeyToPubkey(seed);
    // Cache the pubkey for getWalletPubkey() callers.
    pubkeyCache = walletPubkey;
    return { signature, walletPubkey };
  } finally {
    // Heb 4:13 — nothing hid; the privkey is zeroed before the function
    // returns even on the happy path.
    safeZero(seed);
  }
}

/**
 * v7.2 generic signer — Ed25519 over arbitrary message bytes under the
 * same x402-wallet-bound key as `sign()`.
 *
 * Use cases:
 *   - W23 session-park: sign canonical body of /v1/session/park (not the
 *     fill-fragment shape — a different canonical JSON).
 *   - W23 session-restore challenge: sign `<sessionId> || ":" || timestamp`.
 *
 * Same security posture as `sign()`: privkey is loaded into a single
 * scope-local buffer, used once, zeroed in finally. Returns the same
 * (signature, walletPubkey) shape so callers can hex-encode uniformly.
 *
 * Mt 6:6 — secret behind closed doors; the key never leaves keychain
 * scope longer than one call.
 */
export async function signBytes(message: Uint8Array): Promise<Signature> {
  const seed = ensureWalletKey();
  try {
    const pkcs8 = seedToPkcs8(seed);
    const privKeyObject = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const sigBuf = nodeSign(null, message, privKeyObject);
    const signature = new Uint8Array(sigBuf);
    const walletPubkey = privkeyToPubkey(seed);
    pubkeyCache = walletPubkey;
    return { signature, walletPubkey };
  } finally {
    safeZero(seed);
  }
}

/**
 * Return the x402 wallet pubkey without signing. Used at adapter
 * `ensureReady()` so first-fill latency does not include key load.
 * Idempotent: same value on every call.
 */
export async function getWalletPubkey(): Promise<Uint8Array> {
  if (pubkeyCache) return pubkeyCache;
  const seed = ensureWalletKey();
  try {
    const pubkey = privkeyToPubkey(seed);
    pubkeyCache = pubkey;
    return pubkey;
  } finally {
    safeZero(seed);
  }
}

// ─── Base58 (Solana address encoding) ──────────────────────────────────────
// Self-contained big-num base58 encoder (Bitcoin/Solana alphabet). A 32-byte
// Ed25519 pubkey base58-encodes to the canonical Solana address. No dependency.
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const input = Array.from(bytes); // mutable working copy for repeated division
  const out: string[] = [];
  let begin = zeros;
  while (begin < input.length) {
    let remainder = 0;
    for (let i = begin; i < input.length; i++) {
      const acc = (remainder << 8) + input[i];
      input[i] = (acc / 58) | 0;
      remainder = acc % 58;
    }
    out.push(B58_ALPHABET[remainder]);
    while (begin < input.length && input[begin] === 0) begin++;
  }
  return "1".repeat(zeros) + out.reverse().join("");
}

// ─── Local self-custody identity wallet (the agent's stable identity) ────────
// The signing key (above) is unbrowse's own self-custody identity. This writes
// a PUBLIC pointer to it into ~/.unbrowse so the user always has a visible
// wallet on their machine — the address + pubkey are public; the seed never
// leaves the keychain / encrypted wallet.enc. Distinct from the lobster.cash
// PAYOUT wallet (src/payments/wallet.ts), which receives USDC.
function localWalletPointer(): string {
  return join(walletDir(), "wallet.json");
}

interface LocalWalletPointer {
  address: string;       // base58 Solana address
  pubkey_hex: string;    // 32-byte Ed25519 pubkey, hex
  provider: string;      // "unbrowse-local"
  created_at: string;    // ISO; preserved across runs (idempotent)
}

/**
 * Ensure a local self-custody wallet exists in ~/.unbrowse and return its
 * base58 address. Mints the key if absent (via ensureWalletKey — keychain on
 * macOS, ~/.unbrowse/wallet.enc otherwise), then writes a public identity
 * pointer (~/.unbrowse/wallet.json). Idempotent: the same address every call,
 * and the pointer is only (re)written when absent or when its address no longer
 * matches the key (created_at is preserved). Heb 13:8 — the same yesterday,
 * today, and forever.
 */
export function ensureLocalWalletAddress(): string {
  const seed = ensureWalletKey();
  let pub: Uint8Array;
  try {
    pub = privkeyToPubkey(seed);
  } finally {
    safeZero(seed);
  }
  const address = base58Encode(pub);
  // Best-effort public pointer: a valid address is returned even if the write
  // fails (read-only fs). The address itself is the load-bearing return value.
  try {
    const dir = walletDir();
    const pointerPath = localWalletPointer();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    let createdAt = new Date().toISOString();
    let needWrite = true;
    if (existsSync(pointerPath)) {
      try {
        const prev = JSON.parse(readFileSync(pointerPath, "utf8")) as Partial<LocalWalletPointer>;
        if (typeof prev.created_at === "string") createdAt = prev.created_at;
        if (prev.address === address) needWrite = false;
      } catch {
        // corrupt pointer — rewrite from the key (the key is the source of truth)
      }
    }
    if (needWrite) {
      const pointer: LocalWalletPointer = {
        address,
        pubkey_hex: bytesToHex(pub),
        provider: "unbrowse-local",
        created_at: createdAt,
      };
      writeFileSync(pointerPath, JSON.stringify(pointer, null, 2) + "\n", { mode: 0o600 });
    }
  } catch {
    // pointer is best-effort; the derived address is still valid + idempotent.
  }
  return address;
}

/**
 * Read the local self-custody wallet's base58 address from the public pointer
 * (~/.unbrowse/wallet.json) WITHOUT minting. Returns null when no wallet has
 * been created yet. Use this for read-only identity surfacing (account view,
 * wallet-context fallback) so merely *checking* never creates key state — the
 * minting stays in ensureLocalWalletAddress(), called from setup / `account`.
 */
export function readLocalWalletAddress(): string | null {
  try {
    const pointerPath = localWalletPointer();
    if (!existsSync(pointerPath)) return null;
    const p = JSON.parse(readFileSync(pointerPath, "utf8")) as Partial<LocalWalletPointer>;
    return typeof p.address === "string" && p.address.length > 0 ? p.address : null;
  } catch {
    return null;
  }
}

// ─── Base64 helper (separate so tests can verify alignment with audit.ts) ───

function bytesToBase64(bytes: Uint8Array): string {
  // Node Buffer round-trip — works under Bun and Node alike.
  return Buffer.from(bytes).toString("base64");
}

/** Exposed for tests + diagnostics — NOT for general use. */
export const __internal = {
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  // Resolved lazily so tests reading these reflect the active (possibly
  // isolated via UNBROWSE_WALLET_DIR) location, not a frozen module-load path.
  get FILE_FALLBACK_PATH() { return walletEncPath(); },
  get LOCAL_WALLET_POINTER() { return localWalletPointer(); },
  walletDir,
  keychainEnabled,
  bytesToHex,
  bytesToBase64,
  base58Encode,
  privkeyToPubkey,
};
