import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

const KEY_PREFIX = "ubr";
const KEY_BODY_BYTES = 24;
const HASH_KEY_PREFIX = "keyhash:";

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

async function storeKeyHash(env: Env, keyHash: string, keyId: string, name: string): Promise<void> {
  await statsKV(env).put(`${HASH_KEY_PREFIX}${keyHash}`, JSON.stringify({
    keyId,
    name,
    created_at: new Date().toISOString(),
    revoked_at: null as string | null,
  }));
}

export async function createLocalKey(
  env: Env,
  name: string,
): Promise<{ keyId: string; key: string }> {
  const { key, keyId } = generateLocalKey();
  const keyHash = await sha256Hex(new TextEncoder().encode(key));
  await storeKeyHash(env, keyHash, keyId, name);
  return { keyId, key };
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
    const meta = JSON.parse(raw) as { keyId: string; revoked_at: string | null };
    if (meta.revoked_at) {
      return { valid: false };
    }
    return { valid: true, keyId: meta.keyId };
  } catch {
    return { valid: false };
  }
}

export async function revokeLocalKey(env: Env, keyId: string): Promise<boolean> {
  return false;
}
