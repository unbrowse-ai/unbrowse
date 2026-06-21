import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { log } from "../logger.js";
import { sealToWallet, revealForWallet, type WalletSealed } from "../trust/sealed-cache.js";
import { deriveSealKey as deriveWalletSealKey } from "../values/signer.js";

/** The sealing secret for vault credentials at rest. DEFAULT-ON, no escape hatch:
 *  with zero configuration, the secret is derived from the local wallet
 *  (`signer.deriveSealKey` — a stable, holder-only HKDF over the wallet seed), so
 *  every credential VALUE is sealed to the wallet at rest and the vault file/keychain
 *  holds only opaque ciphertext. `UNBROWSE_WALLET_SECRET` still takes PRECEDENCE
 *  (preserves any vault already sealed under an explicit secret). Returns null only
 *  when the wallet seal-key genuinely cannot be derived — surfaced via an evidence
 *  line (never silent), and the prior local-AES-at-rest path bears the load.
 *  Tradeoff (accepted, surfaced): a wallet rotation orphans creds sealed under the old
 *  key — they return null on read → the caller re-auths (graceful, no corruption). */
let cachedSealSecret: string | null | undefined; // undefined = not yet computed this process
function getWalletSecret(): string | null {
  const explicit = process.env.UNBROWSE_WALLET_SECRET?.trim();
  if (explicit) return explicit;
  if (cachedSealSecret !== undefined) return cachedSealSecret;
  try {
    const key = deriveWalletSealKey();
    cachedSealSecret = Buffer.from(key).toString("hex");
  } catch (e) {
    log("vault", `wallet seal-key underivable (${(e as Error)?.message ?? String(e)}) — credentials stored under local-AES at rest, not wallet-sealed`);
    cachedSealSecret = null;
  }
  return cachedSealSecret;
}

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

/**
 * On macOS, keytar's native setPassword calls SecKeychainAddGenericPassword, which pops a
 * blocking "Keychain Not Found" modal dialog when there is no usable default login keychain
 * (a corrupted / reset / headless keychain search list). That dialog freezes the CLI on a
 * system prompt the agent cannot dismiss. Pre-flight the keychain NON-INTERACTIVELY via the
 * `security` CLI (which never pops a dialog): if the default keychain is missing or its file
 * does not exist, disable keytar so the encrypted file vault takes over silently — no prompt.
 * Honors UNBROWSE_NO_KEYCHAIN=1 as an explicit opt-out (force the file vault).
 */
function macKeychainUsable(): boolean {
  if (process.platform !== "darwin") return true;
  const v = (process.env.UNBROWSE_NO_KEYCHAIN ?? "").toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return false;
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execFileSync("security", ["default-keychain"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).toString();
    const m = out.match(/"([^"]+)"/);
    if (!m) return false; // no default keychain configured
    return existsSync(m[1]); // the keychain file must actually exist on disk
  } catch {
    return false; // `security` errored / no keychain → unusable
  }
}

if (keytar && !macKeychainUsable()) {
  keytar = null;
  log("vault", "macOS default keychain unavailable; using encrypted file vault (no keychain prompt)");
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

// keytar errors come in two flavors:
//   1. Binding errors (module load, dlopen, no native build, missing
//      method): the runtime is unusable, permanently disable.
//   2. Operation errors (keychain ACL, sandbox refusal, opaque
//      "An unknown error occurred." with no stack on macOS when an
//      entry was created under a different code-signature/ACL): the
//      runtime works, but THIS call fails. Returning
//      KEYTAR_UNAVAILABLE lets the file backend take over per-call
//      without breaking subsequent keytar usage for other accounts.
async function callKeytar<T>(op: (client: KeytarClient) => Promise<T>): Promise<T | typeof KEYTAR_UNAVAILABLE> {
  if (!keytar) return KEYTAR_UNAVAILABLE;
  try {
    return await op(keytar);
  } catch (error) {
    if (isKeytarBindingError(error)) {
      disableKeytar(error);
      return KEYTAR_UNAVAILABLE;
    }
    // Operation-level keytar errors fall back to file backend instead of
    // surfacing as throws. Issue #70 reproduced this with a macOS ACL
    // failure on a previously-created vault entry: keytar threw an
    // opaque "An unknown error occurred." that the binding regex did not
    // match, so storeCredential propagated the throw and any caller
    // depending on auth-vault state died. Bun's local pre-release hook
    // (test:issue-regressions) was the canary.
    const summary = error instanceof Error ? error.message : String(error);
    log("vault", `keytar operation failed (${summary}); falling back to encrypted file for this call`);
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
  /** When the credential is sealed to the holder's wallet, the opaque sealed
   *  blob (value is emptied). Only the wallet-holder can open it; the expiry
   *  metadata above stays in clear so eviction still works without the wallet. */
  sealed?: WalletSealed;
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
  // Wallet-sealed at rest: when a wallet secret is configured, seal the VALUE to
  // the holder's wallet and store only the opaque blob (no plaintext on disk /
  // in the keychain). The expiry metadata stays in clear so eviction works.
  const walletSecret = getWalletSecret();
  if (walletSecret) {
    wrapped.sealed = await sealToWallet(value, walletSecret, account);
    wrapped.value = "";
  }
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
    if (parsed.sealed && parsed.stored_at) {
      // Wallet-sealed credential — check expiry (clear metadata) then open it
      // with the holder's wallet. No wallet / wrong wallet → cannot open → null.
      if (isExpired(parsed)) {
        await deleteExpired();
        return null;
      }
      const walletSecret = getWalletSecret();
      if (!walletSecret) return null;
      try {
        return (await revealForWallet(parsed.sealed, walletSecret, account)) as string;
      } catch {
        // Sealed under a different wallet key (rotation) or tampered → cannot open.
        // Graceful: return null so the caller re-auths. Surfaced, never silent.
        log("vault", `sealed credential for ${account} could not be opened under the current wallet (rotated?) — re-auth needed`);
        return null;
      }
    }
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

/**
 * List vault account keys, optionally filtered by prefix.
 *
 * Returns metadata only — never returns the stored value. The intended use
 * is for MCP resources that surface "which domains have a saved profile"
 * without exposing secrets. Reads the same store backend (keychain or
 * encrypted file) that getCredential reads.
 *
 * Returns one entry per account key with stored_at / expires_at parsed
 * from the StoredCredential envelope when present (legacy raw strings
 * yield null timestamps).
 */
export interface VaultKeyMeta {
  account: string;
  stored_at: string | null;
  expires_at: string | null;
}

export async function listVaultKeys(prefix?: string): Promise<VaultKeyMeta[]> {
  const store = await readVaultStore();
  const out: VaultKeyMeta[] = [];
  for (const [account, raw] of Object.entries(store.data)) {
    if (prefix && !account.startsWith(prefix)) continue;
    let stored_at: string | null = null;
    let expires_at: string | null = null;
    try {
      const parsed = JSON.parse(raw) as Partial<StoredCredential>;
      if (parsed && typeof parsed === "object") {
        stored_at = parsed.stored_at ?? null;
        expires_at = parsed.expires_at ?? null;
      }
    } catch {
      // legacy raw string — no timestamps available
    }
    out.push({ account, stored_at, expires_at });
  }
  return out;
}
