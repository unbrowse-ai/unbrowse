import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

let keytar: typeof import("keytar") | null = null;
try {
  keytar = await import("keytar");
} catch {
  // keytar unavailable -- use encrypted file fallback
}

export interface StoredCredential {
  value: string;
  stored_at: string;
  expires_at?: string;
  max_age_ms?: number;
}

const SERVICE = "unbrowse";
const VAULT_DIR = join(process.cwd(), ".vault");
const VAULT_FILE = join(VAULT_DIR, "credentials.enc");
const KEY_FILE = join(VAULT_DIR, ".key");

function getOrCreateKey(): Buffer {
  if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE);
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
}

// Async mutex to prevent concurrent read-modify-write races
let vaultLock: Promise<void> = Promise.resolve();
function withVaultLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const prev = vaultLock;
  let release: () => void;
  vaultLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(() => release!());
}

function readVaultFile(): Record<string, string> {
  if (!existsSync(VAULT_FILE)) return {};
  try {
    const key = getOrCreateKey();
    const raw = readFileSync(VAULT_FILE);
    const iv = raw.subarray(0, 16);
    const enc = raw.subarray(16);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(dec.toString("utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeVaultFile(data: Record<string, string>): void {
  const key = getOrCreateKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
  writeFileSync(VAULT_FILE, Buffer.concat([iv, enc]), { mode: 0o600 });
}

export async function storeCredential(
  account: string,
  value: string,
  opts?: { expires_at?: string; max_age_ms?: number }
): Promise<void> {
  const wrapped: StoredCredential = {
    value,
    stored_at: new Date().toISOString(),
    expires_at: opts?.expires_at,
    max_age_ms: opts?.max_age_ms,
  };
  const serialized = JSON.stringify(wrapped);
  if (keytar) { await keytar.setPassword(SERVICE, account, serialized); return; }
  await withVaultLock(() => {
    const data = readVaultFile();
    data[account] = serialized;
    writeVaultFile(data);
  });
}

function isExpired(cred: StoredCredential): boolean {
  if (cred.expires_at) {
    return new Date(cred.expires_at).getTime() <= Date.now();
  }
  if (cred.max_age_ms) {
    return new Date(cred.stored_at).getTime() + cred.max_age_ms <= Date.now();
  }
  return false;
}

export async function getCredential(account: string): Promise<string | null> {
  let raw: string | null;
  if (keytar) {
    raw = await keytar.getPassword(SERVICE, account);
  } else {
    const data = readVaultFile();
    raw = data[account] ?? null;
  }
  if (!raw) return null;

  // Try to parse as StoredCredential; backward-compat: raw strings are legacy (no expiry)
  try {
    const parsed = JSON.parse(raw) as StoredCredential;
    if (parsed.value && parsed.stored_at) {
      // It's a wrapped credential — check expiry
      if (isExpired(parsed)) {
        await deleteCredential(account);
        return null;
      }
      return parsed.value;
    }
  } catch {
    // Not JSON — legacy raw string, return as-is
  }
  return raw;
}

export async function deleteCredential(account: string): Promise<void> {
  if (keytar) { await keytar.deletePassword(SERVICE, account); return; }
  await withVaultLock(() => {
    const data = readVaultFile();
    delete data[account];
    writeVaultFile(data);
  });
}
