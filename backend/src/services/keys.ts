import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

const KEY_PREFIX = "ubr";
const KEY_BODY_BYTES = 24;
const HASH_KEY_PREFIX = "keyhash:";
// Reverse index keyId -> hash + metadata. Without this, revoke-by-keyId is
// impossible (the plaintext key, and thus its hash, is never retained after
// creation). This is the missing piece the old revokeLocalKey stub lacked.
const KEYID_PREFIX = "keyid:";
// Per-key x402 funding binding (L6 api-key-wrapping-x402).
const KEYFUND_PREFIX = "keyfund:";

export function generateLocalKey(): { key: string; keyId: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BODY_BYTES));
  const body = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  const key = `${KEY_PREFIX}_${body}`;
  const keyId = body.slice(0, 32);
  return { key, keyId };
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  if (typeof crypto !== "undefined" && "subtle" in crypto && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  }
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < data.length; i++) {
    h1 = 31 * h1 + data[i] * 7;
    h2 = 31 * h2 + data[i] * 13;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(h1) + hex(h2) + hex(h1 ^ h2) + hex(h2 ^ h1);
}

interface KeyHashRecord {
  keyId: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}

export interface KeyMeta {
  keyId: string;
  name: string;
  created_at: string;
  revoked_at: string | null;
}

interface KeyIdRecord extends KeyMeta {
  keyHash: string;
}

async function storeKeyRecords(env: Env, keyHash: string, keyId: string, name: string): Promise<KeyMeta> {
  const created_at = new Date().toISOString();
  const hashRec: KeyHashRecord = { keyId, name, created_at, revoked_at: null };
  const idRec: KeyIdRecord = { keyId, keyHash, name, created_at, revoked_at: null };
  const kv = statsKV(env);
  await kv.put(`${HASH_KEY_PREFIX}${keyHash}`, JSON.stringify(hashRec));
  await kv.put(`${KEYID_PREFIX}${keyId}`, JSON.stringify(idRec));
  return { keyId, name, created_at, revoked_at: null };
}

export async function createLocalKey(
  env: Env,
  name: string,
): Promise<{ keyId: string; key: string; meta: KeyMeta }> {
  const { key, keyId } = generateLocalKey();
  const keyHash = await sha256Hex(new TextEncoder().encode(key));
  const meta = await storeKeyRecords(env, keyHash, keyId, name);
  return { keyId, key, meta };
}

export async function verifyLocalKey(
  env: Env,
  key: string,
): Promise<{ valid: boolean; keyId?: string }> {
  if (!key || !key.startsWith(`${KEY_PREFIX}_`)) {
    return { valid: false };
  }

  const keyHash = await sha256Hex(new TextEncoder().encode(key));
  const raw = await statsKV(env).get(`${HASH_KEY_PREFIX}${keyHash}`) as string | null;
  if (!raw) {
    return { valid: false };
  }

  try {
    const meta = JSON.parse(raw) as KeyHashRecord;
    if (meta.revoked_at) {
      return { valid: false };
    }
    return { valid: true, keyId: meta.keyId };
  } catch {
    return { valid: false };
  }
}

/** Read key metadata (name, created_at, revoked_at) by keyId for the account list. */
export async function getKeyMeta(env: Env, keyId: string): Promise<KeyMeta | null> {
  const raw = await statsKV(env).get(`${KEYID_PREFIX}${keyId}`) as string | null;
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as KeyIdRecord;
    return { keyId: rec.keyId, name: rec.name, created_at: rec.created_at, revoked_at: rec.revoked_at };
  } catch {
    return null;
  }
}

/**
 * Revoke a key by keyId. Flips revoked_at on BOTH the keyhash record (which
 * verifyLocalKey reads on every authenticated request) and the keyid reverse
 * record. Returns false when the keyId is unknown so callers can 404.
 */
export async function revokeLocalKey(env: Env, keyId: string): Promise<boolean> {
  const kv = statsKV(env);
  const raw = await kv.get(`${KEYID_PREFIX}${keyId}`) as string | null;
  if (!raw) return false;
  let rec: KeyIdRecord;
  try {
    rec = JSON.parse(raw) as KeyIdRecord;
  } catch {
    return false;
  }
  if (rec.revoked_at) return true; // idempotent
  const now = new Date().toISOString();
  rec.revoked_at = now;
  await kv.put(`${KEYID_PREFIX}${keyId}`, JSON.stringify(rec));

  const hashRaw = await kv.get(`${HASH_KEY_PREFIX}${rec.keyHash}`) as string | null;
  if (hashRaw) {
    try {
      const hashRec = JSON.parse(hashRaw) as KeyHashRecord;
      hashRec.revoked_at = now;
      await kv.put(`${HASH_KEY_PREFIX}${rec.keyHash}`, JSON.stringify(hashRec));
    } catch {
      // keyhash record corrupt — keyid record is already flipped, so the
      // key still loses its account binding even if verify can't see it.
    }
  }
  await kv.delete(`${KEYFUND_PREFIX}${keyId}`);
  await clearKeyWallet(env, keyId); // also drop the wallet binding + its reverse index
  return true;
}

// --- L6: API key wrapping x402 ---

export type KeyFunding =
  // A wallet-bound key. `wallet` is the owner-of-record (refund/payout target).
  // `balance_uc` is a SPENDABLE BALANCE (µ¢) the wallet DEPOSITED into this key
  // via a one-time x402 top-up (POST .../deposit). The key SPENDS this balance on
  // every later call through the same debit path as kind:"credit" — the platform
  // never pays for the call and never holds the wallet key. Optional + defaults
  // to 0 so a pre-existing wallet binding (no deposit yet) is backward-compatible:
  // it simply has no spendable balance and falls through to the per-call 402.
  | { kind: "wallet"; wallet: string; balance_uc?: number; bound_at: string }
  | { kind: "credit"; budget_uc: number; bound_at: string };

// Distributive Omit so the discriminated union keeps its per-variant fields
// (a plain Omit<Union, K> collapses to the common keys only).
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type KeyFundingInput = DistributiveOmit<KeyFunding, "bound_at">;

export async function getKeyFunding(env: Env, keyId: string): Promise<KeyFunding | null> {
  const raw = await statsKV(env).get(`${KEYFUND_PREFIX}${keyId}`) as string | null;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as KeyFunding;
  } catch {
    return null;
  }
}

export async function setKeyFunding(env: Env, keyId: string, funding: KeyFundingInput): Promise<KeyFunding> {
  const rec = { ...funding, bound_at: new Date().toISOString() } as KeyFunding;
  await statsKV(env).put(`${KEYFUND_PREFIX}${keyId}`, JSON.stringify(rec));
  return rec;
}

export async function clearKeyFunding(env: Env, keyId: string): Promise<void> {
  await statsKV(env).delete(`${KEYFUND_PREFIX}${keyId}`);
}

// --- web3-PK binding: the api_key (web2 wrapper) ↔ wallet pubkey (the root) ---
// Additive + backward-compatible (clones the keyfund: pattern): a key with no
// keypub: record is simply "unbound" (null), exactly like an unfunded key — the
// request path is untouched, so existing keys + agent_ids are unaffected. The
// reverse index pubkey:<pubkey> → keyId lets the signature-auth path (a later
// increment) resolve the SAME agent_id as the bound key, so the PK is the root
// and the key is its wrapper, not a separate identity.
const KEYPUB_PREFIX = "keypub:";   // keypub:<keyId>  -> { wallet_pubkey, bound_at }
const PUBKEY_PREFIX = "pubkey:";   // pubkey:<pubkey> -> keyId  (reverse index)

export interface KeyWalletBinding { wallet_pubkey: string; bound_at: string }

export async function getKeyWallet(env: Env, keyId: string): Promise<KeyWalletBinding | null> {
  const raw = await statsKV(env).get(`${KEYPUB_PREFIX}${keyId}`) as string | null;
  if (!raw) return null;
  try { return JSON.parse(raw) as KeyWalletBinding; } catch { return null; }
}

/**
 * Bind a wallet pubkey to a key. Returns the binding, or null if the pubkey is
 * already owned by a DIFFERENT key (hijack prevention).
 *
 * Threat (found in the judgement-step audit): a raw last-writer-wins put on the
 * reverse index would let key A claim key B's pubkey, so B's signatures resolve to
 * A's agent — identity hijack. So a pubkey already bound elsewhere is refused here
 * (defense-in-depth). The bind ROUTE must ADDITIONALLY prove pubkey control via a
 * signature challenge — this primitive guard is the second line, not the first.
 */
export async function setKeyWallet(env: Env, keyId: string, walletPubkey: string): Promise<KeyWalletBinding | null> {
  const kv = statsKV(env);
  const existingOwner = await keyIdForPubkey(env, walletPubkey);
  if (existingOwner && existingOwner !== keyId) return null; // pubkey already owned → refuse hijack
  // Rebinding this key to a new pubkey: drop its stale reverse index first.
  const prior = await getKeyWallet(env, keyId);
  if (prior && prior.wallet_pubkey !== walletPubkey) {
    await kv.delete(`${PUBKEY_PREFIX}${prior.wallet_pubkey}`);
  }
  const rec: KeyWalletBinding = { wallet_pubkey: walletPubkey, bound_at: new Date().toISOString() };
  await kv.put(`${KEYPUB_PREFIX}${keyId}`, JSON.stringify(rec));
  await kv.put(`${PUBKEY_PREFIX}${walletPubkey}`, keyId); // reverse index for signature-auth
  return rec;
}

/** Resolve the agent (keyId) bound to a wallet pubkey — the signature-auth path's lookup. */
export async function keyIdForPubkey(env: Env, walletPubkey: string): Promise<string | null> {
  return (await statsKV(env).get(`${PUBKEY_PREFIX}${walletPubkey}`)) as string | null;
}

export async function clearKeyWallet(env: Env, keyId: string): Promise<void> {
  const kv = statsKV(env);
  const existing = await getKeyWallet(env, keyId);
  await kv.delete(`${KEYPUB_PREFIX}${keyId}`);
  if (existing) await kv.delete(`${PUBKEY_PREFIX}${existing.wallet_pubkey}`);
}

/**
 * Credit a wallet-bound key's spendable balance by amountUc (micro-cents). This
 * is money-IN: the wallet has DEPOSITED USDC (verified by a confirmed x402 at the
 * deposit route) and the platform records the paid amount as the key's balance.
 * The key then SPENDS this balance on later calls via debitKeyFunding.
 *
 * Idempotent on the binding shape: requires an existing kind:"wallet" binding
 * (the deposit funds an already-bound wallet key). Returns the new balance, or
 * { ok:false } when the key has no wallet binding (deposit must target a bound
 * wallet key). The platform NEVER holds the wallet's private key — it only adds
 * to a balance the wallet itself funded.
 */
export async function creditKeyWalletBalance(
  env: Env,
  keyId: string,
  amountUc: number,
): Promise<{ ok: true; balance_uc: number; wallet: string } | { ok: false; reason: "no_wallet_binding" | "invalid_amount" }> {
  if (!Number.isFinite(amountUc) || amountUc <= 0) {
    return { ok: false, reason: "invalid_amount" };
  }
  const funding = await getKeyFunding(env, keyId);
  if (!funding || funding.kind !== "wallet") {
    return { ok: false, reason: "no_wallet_binding" };
  }
  const balance_uc = (funding.balance_uc ?? 0) + Math.floor(amountUc);
  const next: KeyFunding = { kind: "wallet", wallet: funding.wallet, balance_uc, bound_at: funding.bound_at };
  await statsKV(env).put(`${KEYFUND_PREFIX}${keyId}`, JSON.stringify(next));
  return { ok: true, balance_uc, wallet: funding.wallet };
}

/**
 * Debit a balance-bearing key by amountUc (micro-cents). Two lanes share this
 * single always-on debit path (no flag):
 *   - kind:"credit"  → debits budget_uc.
 *   - kind:"wallet"  → debits the wallet-DEPOSITED balance_uc (the wallet topped
 *                      it up via a one-time x402; the key now spends it). The
 *                      platform never pays — it only spends down a balance the
 *                      wallet funded.
 * Returns { ok:true, remaining_uc } when the balance covered it (decremented), or
 * { ok:false, reason } when the key has no spendable binding or the balance is
 * insufficient (balance left untouched -> caller falls through to the per-call 402).
 */
export async function debitKeyFunding(
  env: Env,
  keyId: string,
  amountUc: number,
): Promise<{ ok: true; remaining_uc: number } | { ok: false; reason: "no_balance_binding" | "insufficient"; remaining_uc: number }> {
  if (!Number.isFinite(amountUc) || amountUc < 0) {
    return { ok: false, reason: "no_balance_binding", remaining_uc: 0 };
  }
  const funding = await getKeyFunding(env, keyId);
  if (!funding) {
    return { ok: false, reason: "no_balance_binding", remaining_uc: 0 };
  }

  if (funding.kind === "credit") {
    if (funding.budget_uc < amountUc) {
      return { ok: false, reason: "insufficient", remaining_uc: funding.budget_uc };
    }
    const remaining = funding.budget_uc - amountUc;
    const next: KeyFunding = { kind: "credit", budget_uc: remaining, bound_at: funding.bound_at };
    await statsKV(env).put(`${KEYFUND_PREFIX}${keyId}`, JSON.stringify(next));
    return { ok: true, remaining_uc: remaining };
  }

  // kind:"wallet" — debit the wallet-deposited spendable balance.
  const balance = funding.balance_uc ?? 0;
  if (balance < amountUc) {
    return { ok: false, reason: "insufficient", remaining_uc: balance };
  }
  const remaining = balance - amountUc;
  const next: KeyFunding = { kind: "wallet", wallet: funding.wallet, balance_uc: remaining, bound_at: funding.bound_at };
  await statsKV(env).put(`${KEYFUND_PREFIX}${keyId}`, JSON.stringify(next));
  return { ok: true, remaining_uc: remaining };
}
