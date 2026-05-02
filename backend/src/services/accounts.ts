import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

// Non-overlapping prefixes: "user:" would be a string-prefix of "userid:", so we use "acct:" + "uid:".
const ACCT_PREFIX = "acct:";
const UID_PREFIX = "uid:";
const KEY2USER_PREFIX = "key2user:";
const USERKEYS_PREFIX = "userkeys:";

export interface UserRecord {
  user_id: string;
  email: string;
  created_at: string;
  verified_at?: string;
  share_pointers?: boolean;
}

export interface AccountPreferences {
  share_pointers: boolean;
}

interface UidRow { email: string }
interface UserKeysRow { keyIds: string[] }

function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!e) throw new Error("email required");
  return e;
}

export function generateUserId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

export async function getUserByEmail(env: Env, email: string): Promise<UserRecord | null> {
  const e = normalizeEmail(email);
  const raw = await statsKV(env).get(`${ACCT_PREFIX}${e}`) as string | null;
  if (!raw) return null;
  return JSON.parse(raw) as UserRecord;
}

export async function getUserById(env: Env, userId: string): Promise<UserRecord | null> {
  const raw = await statsKV(env).get(`${UID_PREFIX}${userId}`) as string | null;
  if (!raw) return null;
  const { email } = JSON.parse(raw) as UidRow;
  return getUserByEmail(env, email);
}

export async function upsertUser(env: Env, email: string, opts?: { verifyNow?: boolean }): Promise<UserRecord> {
  const e = normalizeEmail(email);
  const kv = statsKV(env);
  const existing = await getUserByEmail(env, e);
  const now = new Date().toISOString();
  if (existing) {
    if (opts?.verifyNow && !existing.verified_at) {
      const updated: UserRecord = { ...existing, verified_at: now };
      await kv.put(`${ACCT_PREFIX}${e}`, JSON.stringify(updated));
      return updated;
    }
    return existing;
  }
  const user_id = generateUserId();
  const rec: UserRecord = { user_id, email: e, created_at: now };
  if (opts?.verifyNow) rec.verified_at = now;
  await kv.put(`${ACCT_PREFIX}${e}`, JSON.stringify(rec));
  await kv.put(`${UID_PREFIX}${user_id}`, JSON.stringify({ email: e } satisfies UidRow));
  return rec;
}

export async function bindKeyToUser(env: Env, keyId: string, userId: string): Promise<void> {
  const kv = statsKV(env);
  await kv.put(`${KEY2USER_PREFIX}${keyId}`, userId);
  const raw = await kv.get(`${USERKEYS_PREFIX}${userId}`) as string | null;
  const row: UserKeysRow = raw ? JSON.parse(raw) as UserKeysRow : { keyIds: [] };
  if (!row.keyIds.includes(keyId)) row.keyIds.push(keyId);
  await kv.put(`${USERKEYS_PREFIX}${userId}`, JSON.stringify(row));
}

export async function lookupUserIdByKey(env: Env, keyId: string): Promise<string | null> {
  const v = await statsKV(env).get(`${KEY2USER_PREFIX}${keyId}`) as string | null;
  return v && v.length > 0 ? v : null;
}

export async function listKeysForUser(env: Env, userId: string): Promise<string[]> {
  const raw = await statsKV(env).get(`${USERKEYS_PREFIX}${userId}`) as string | null;
  if (!raw) return [];
  return (JSON.parse(raw) as UserKeysRow).keyIds;
}

export async function getAccountPreferences(env: Env, userId: string): Promise<AccountPreferences> {
  const user = await getUserById(env, userId);
  if (!user) throw new Error("user_not_found");
  return { share_pointers: user.share_pointers ?? false };
}

export async function setAccountPreferences(env: Env, userId: string, prefs: Partial<AccountPreferences>): Promise<AccountPreferences> {
  if (prefs.share_pointers !== undefined && typeof prefs.share_pointers !== "boolean") {
    throw new Error("invalid_input");
  }
  const user = await getUserById(env, userId);
  if (!user) throw new Error("user_not_found");
  const updated: UserRecord = { ...user };
  if (prefs.share_pointers !== undefined) updated.share_pointers = prefs.share_pointers;
  await statsKV(env).put(`${ACCT_PREFIX}${user.email}`, JSON.stringify(updated));
  return { share_pointers: updated.share_pointers ?? false };
}
