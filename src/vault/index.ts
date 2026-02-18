import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

let keytar: typeof import("keytar") | null = null;
try {
  keytar = await import("keytar");
} catch {
  // keytar unavailable -- use encrypted file fallback
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

export async function storeCredential(account: string, value: string): Promise<void> {
  if (keytar) { await keytar.setPassword(SERVICE, account, value); return; }
  const data = readVaultFile();
  data[account] = value;
  writeVaultFile(data);
}

export async function getCredential(account: string): Promise<string | null> {
  if (keytar) return keytar.getPassword(SERVICE, account);
  const data = readVaultFile();
  return data[account] ?? null;
}

export async function deleteCredential(account: string): Promise<void> {
  if (keytar) { await keytar.deletePassword(SERVICE, account); return; }
  const data = readVaultFile();
  delete data[account];
  writeVaultFile(data);
}
