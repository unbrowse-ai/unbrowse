import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

/**
 * Per-account encrypted cookie vault (L4).
 *
 * Envelope encryption:
 *   - KEK (key-encryption key): SHA-256(COOKIE_VAULT_MASTER_KEY) imported as
 *     an AES-GCM 256 key. Never persisted.
 *   - DEK (data-encryption key): 32 random bytes generated per user on first
 *     write, wrapped (AES-GCM) under the KEK and stored at
 *     `cookievault:dek:<user_id>`. Never persisted in plaintext.
 *   - Payload: cookies JSON encrypted (AES-GCM) under the user's DEK at
 *     `cookievault:data:<user_id>:<domain>`. The stored value is base64
 *     ciphertext + iv only -- no cookie name or value is ever greppable.
 *
 * Isolation: every key is namespaced by the user_id resolved from the bearer
 * key by the route. A different user's bearer resolves to a different
 * user_id and therefore cannot address another user's DEK or payloads.
 */

const DEK_PREFIX = "cookievault:dek:";
const DATA_PREFIX = "cookievault:data:";
const IDX_PREFIX = "cookievault:idx:";

export class VaultNotConfiguredError extends Error {
  constructor() {
    super("vault_not_configured");
    this.name = "VaultNotConfiguredError";
  }
}

export interface CookieRecord {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface SyncedDomain {
  domain: string;
  last_sync: string;
  cookie_count: number;
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKEK(env: Env): Promise<CryptoKey> {
  const master = env.COOKIE_VAULT_MASTER_KEY?.trim();
  if (!master) throw new VaultNotConfiguredError();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(master));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

interface Envelope {
  iv: string;
  ct: string;
}

async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ctBuf)) };
}

async function aesDecrypt(key: CryptoKey, env: Envelope): Promise<Uint8Array> {
  const iv = b64decode(env.iv);
  const ct = b64decode(env.ct);
  const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new Uint8Array(ptBuf);
}

async function getOrCreateDEK(env: Env, userId: string): Promise<CryptoKey> {
  const kv = statsKV(env);
  const kek = await deriveKEK(env);
  const raw = (await kv.get(`${DEK_PREFIX}${userId}`)) as string | null;
  if (raw) {
    const envelope = JSON.parse(raw) as Envelope;
    const dekBytes = await aesDecrypt(kek, envelope);
    return crypto.subtle.importKey("raw", dekBytes, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }
  const dekBytes = crypto.getRandomValues(new Uint8Array(32));
  const wrapped = await aesEncrypt(kek, dekBytes);
  await kv.put(`${DEK_PREFIX}${userId}`, JSON.stringify(wrapped));
  return crypto.subtle.importKey("raw", dekBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

async function readIndex(env: Env, userId: string): Promise<SyncedDomain[]> {
  const raw = (await statsKV(env).get(`${IDX_PREFIX}${userId}`)) as string | null;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SyncedDomain[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeIndex(env: Env, userId: string, idx: SyncedDomain[]): Promise<void> {
  await statsKV(env).put(`${IDX_PREFIX}${userId}`, JSON.stringify(idx));
}

/** Encrypt and store a domain's cookie set for this user. Returns the index row. */
export async function pushCookies(
  env: Env,
  userId: string,
  domainRaw: string,
  cookies: CookieRecord[],
): Promise<SyncedDomain> {
  const domain = normalizeDomain(domainRaw);
  if (!domain) throw new Error("invalid_domain");
  const dek = await getOrCreateDEK(env, userId);
  const plaintext = new TextEncoder().encode(JSON.stringify(cookies));
  const envelope = await aesEncrypt(dek, plaintext);
  await statsKV(env).put(`${DATA_PREFIX}${userId}:${domain}`, JSON.stringify(envelope));

  const idx = await readIndex(env, userId);
  const row: SyncedDomain = {
    domain,
    last_sync: new Date().toISOString(),
    cookie_count: cookies.length,
  };
  const existing = idx.findIndex((d) => d.domain === domain);
  if (existing >= 0) idx[existing] = row;
  else idx.push(row);
  await writeIndex(env, userId, idx);
  return row;
}

/** Decrypt and return a domain's cookie set for this user, or null if absent. */
export async function pullCookies(
  env: Env,
  userId: string,
  domainRaw: string,
): Promise<CookieRecord[] | null> {
  const domain = normalizeDomain(domainRaw);
  const raw = (await statsKV(env).get(`${DATA_PREFIX}${userId}:${domain}`)) as string | null;
  if (!raw) return null;
  const dek = await getOrCreateDEK(env, userId);
  const envelope = JSON.parse(raw) as Envelope;
  const plaintext = await aesDecrypt(dek, envelope);
  return JSON.parse(new TextDecoder().decode(plaintext)) as CookieRecord[];
}

/** List the domains this user has synced, with last-sync time and counts. */
export async function listSyncedDomains(env: Env, userId: string): Promise<SyncedDomain[]> {
  // deriveKEK throws VaultNotConfiguredError up to the route when unconfigured
  // so the screen never renders a misleading empty state.
  await deriveKEK(env);
  return readIndex(env, userId);
}

/** Delete one domain's encrypted payload and remove it from the index. */
export async function deleteSyncedDomain(
  env: Env,
  userId: string,
  domainRaw: string,
): Promise<boolean> {
  const domain = normalizeDomain(domainRaw);
  const idx = await readIndex(env, userId);
  const next = idx.filter((d) => d.domain !== domain);
  await statsKV(env).delete(`${DATA_PREFIX}${userId}:${domain}`);
  await writeIndex(env, userId, next);
  return next.length !== idx.length;
}

/** Purge the entire vault for this user: every payload, the DEK, the index. */
export async function purgeVault(env: Env, userId: string): Promise<number> {
  const kv = statsKV(env);
  const idx = await readIndex(env, userId);
  for (const row of idx) {
    await kv.delete(`${DATA_PREFIX}${userId}:${row.domain}`);
  }
  await kv.delete(`${DEK_PREFIX}${userId}`);
  await kv.delete(`${IDX_PREFIX}${userId}`);
  return idx.length;
}
