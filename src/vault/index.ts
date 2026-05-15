import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "../logger.js";

type KeytarClient = {
  setPassword: (service: string, account: string, password: string) => Promise<unknown>;
  getPassword: (service: string, account: string) => Promise<string | null>;
  deletePassword: (service: string, account: string) => Promise<boolean>;
};

const KEYTAR_UNAVAILABLE = Symbol("KEYTAR_UNAVAILABLE");
const KEYTAR_BINDING_ERROR_RE = /(keytar(?:\.node)?|native bindings?|bindings file|no native build was found|could not locate the bindings file|module did not self-register|err_dlopen_failed|dlopen\(|compiled against a different node\.js version|cannot find module .*keytar|wasm is not supported on this platform|(set|get|delete)password is not a function)/i;

export function normalizeKeytarModule(mod: unknown): KeytarClient | null {
  let candidate: unknown = mod;
  for (let depth = 0; depth < 3; depth++) {
    if (!candidate || typeof candidate !== "object" || !("default" in candidate)) break;
    candidate = (candidate as { default?: unknown }).default;
  }
  if (!candidate) return null;
  if (
    typeof (candidate as Partial<KeytarClient>).setPassword === "function" &&
    typeof (candidate as Partial<KeytarClient>).getPassword === "function" &&
    typeof (candidate as Partial<KeytarClient>).deletePassword === "function"
  ) {
    return candidate as KeytarClient;
  }
  return null;
}

let keytar: KeytarClient | null = null;
try {
  keytar = normalizeKeytarModule(await import("keytar"));
} catch {
  // keytar unavailable -- use encrypted file fallback
}
const importedKeytar = keytar;
let keytarFallbackLogged = false;

function isKeytarBindingError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return KEYTAR_BINDING_ERROR_RE.test(message);
}

function disableKeytar(error: unknown): void {
  keytar = null;
  if (keytarFallbackLogged) return;
  const summary = error instanceof Error ? error.message : String(error);
  log("vault", `keytar runtime unavailable (${summary}); using encrypted file fallback`);
  keytarFallbackLogged = true;
}

async function callKeytar<T>(op: (client: KeytarClient) => Promise<T>): Promise<T | typeof KEYTAR_UNAVAILABLE> {
  if (!keytar) return KEYTAR_UNAVAILABLE;
  try {
    return await op(keytar);
  } catch (error) {
    if (!isKeytarBindingError(error)) throw error;
    disableKeytar(error);
    return KEYTAR_UNAVAILABLE;
  }
}

export function setKeytarClientForTests(client: KeytarClient | null): void {
  keytar = client;
  keytarFallbackLogged = false;
}

export function resetKeytarClientForTests(): void {
  keytar = importedKeytar;
  keytarFallbackLogged = false;
}

export interface StoredCredential {
  value: string;
  stored_at: string;
  expires_at?: string;
  max_age_ms?: number;
}

const SERVICE = "unbrowse";
const KEYCHAIN_VAULT_ACCOUNT = "__unbrowse_vault_v1";
// Use a fixed location so the vault works regardless of server CWD
const VAULT_DIR = join(homedir(), ".unbrowse", "vault");
const VAULT_FILE = join(VAULT_DIR, "credentials.enc");
const KEY_FILE = join(VAULT_DIR, ".key");

type VaultBackend = "keytar" | "file";

interface VaultStore {
  backend: VaultBackend;
  data: Record<string, string>;
}

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

function parseKeychainVault(raw: string): Record<string, string> {
  const onlyStringValues = (value: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    if ("credentials" in parsed && typeof (parsed as { credentials?: unknown }).credentials === "object") {
      const credentials = (parsed as { credentials: Record<string, unknown> }).credentials;
      return onlyStringValues(credentials);
    }
    return onlyStringValues(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

function serializeKeychainVault(data: Record<string, string>): string {
  return JSON.stringify({
    schema_version: 1,
    credentials: data,
  });
}

async function readVaultStore(): Promise<VaultStore> {
  const keytarResult = await callKeytar((client) => client.getPassword(SERVICE, KEYCHAIN_VAULT_ACCOUNT));
  if (keytarResult !== KEYTAR_UNAVAILABLE) {
    return {
      backend: "keytar",
      data: keytarResult ? parseKeychainVault(keytarResult) : {},
    };
  }
  return { backend: "file", data: readVaultFile() };
}

async function writeVaultStore(store: VaultStore): Promise<void> {
  if (store.backend === "keytar") {
    const keytarResult = await callKeytar((client) =>
      client.setPassword(SERVICE, KEYCHAIN_VAULT_ACCOUNT, serializeKeychainVault(store.data)),
    );
    if (keytarResult !== KEYTAR_UNAVAILABLE) return;
  }
  writeVaultFile(store.data);
}

async function deleteLegacyKeychainAccount(account: string): Promise<void> {
  const result = await callKeytar((client) => client.deletePassword(SERVICE, account));
  if (result === KEYTAR_UNAVAILABLE) return;
}

async function readLegacyKeychainAccount(account: string): Promise<string | null | typeof KEYTAR_UNAVAILABLE> {
  if (account === KEYCHAIN_VAULT_ACCOUNT) return null;
  return callKeytar((client) => client.getPassword(SERVICE, account));
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
  await withVaultLock(async () => {
    const store = await readVaultStore();
    store.data[account] = serialized;
    await writeVaultStore(store);
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
  let raw: string | null = null;
  await withVaultLock(async () => {
    const store = await readVaultStore();
    raw = store.data[account] ?? null;
    if (raw || store.backend !== "keytar") return;

    const legacy = await readLegacyKeychainAccount(account);
    if (legacy === KEYTAR_UNAVAILABLE || !legacy) return;
    raw = legacy;
    store.data[account] = legacy;
    await writeVaultStore(store);
    await deleteLegacyKeychainAccount(account);
  });
  if (!raw) return null;

  async function deleteExpired(): Promise<void> {
    await withVaultLock(async () => {
      const store = await readVaultStore();
      delete store.data[account];
      await writeVaultStore(store);
    });
    await deleteLegacyKeychainAccount(account);
  }

  // Try to parse as StoredCredential; backward-compat: raw strings are legacy (no expiry)
  try {
    const parsed = JSON.parse(raw) as StoredCredential;
    if (parsed.value && parsed.stored_at) {
      // It's a wrapped credential — check expiry
      if (isExpired(parsed)) {
        await deleteExpired();
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
  await withVaultLock(async () => {
    const store = await readVaultStore();
    delete store.data[account];
    await writeVaultStore(store);
  });
  await deleteLegacyKeychainAccount(account);
}
