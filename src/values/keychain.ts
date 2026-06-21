/**
 * keychain — one OS-agnostic secret store for every adapter.
 *
 * This mirrors pay.sh's own backend model (`pay setup --backend
 * keychain|gnome-keyring|windows-hello`): the secret lives in the OS-protected
 * store, unlocked by the login session, so nothing re-prompts for a password.
 * Every payment/credential adapter (x402 signer, pay.sh rail, lobster, Privy,
 * Crossmint, generic x402) reads its secret through this one surface instead of
 * inventing its own env var or plaintext file.
 *
 * Backends, fastest/most-native first:
 *   - macOS   → `security` against the login keychain, `-A` so sibling spawns
 *               (bun / npm exec / the compiled binary) read without an ACL
 *               prompt. (The proven path the x402 signer already shipped.)
 *   - Linux   → `secret-tool` (libsecret / GNOME Keyring / KWallet via the
 *               Secret Service API).
 *   - Windows → DPAPI (`ProtectedData`, CurrentUser scope) via PowerShell —
 *               per-user, OS-bound, no password. The blob is filed under the
 *               config dir.
 *   - else    → AES-256-GCM encrypted file, key from `UNBROWSE_WALLET_PASSPHRASE`
 *               (or a host-stable salt). Documented best-effort last resort.
 *
 * Values are strings (hex / base58 / base64 / JSON). Binary callers encode
 * before storing — the store never sees raw bytes.
 *
 * Mt 6:6 — "shut thy door, and pray to thy Father which is in secret": the
 * secret stays in the OS store, surfaced only for the one call that needs it.
 */

import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type KeychainBackend =
  | "macos-keychain"
  | "secret-service"
  | "windows-dpapi"
  | "encrypted-file";

export interface SecretStoreOptions {
  /** Directory for the encrypted-file / DPAPI-blob fallback (default ~/.unbrowse). */
  fallbackDir?: string;
  /** Passphrase for the encrypted-file fallback. Default: env or host-stable salt. */
  passphrase?: string;
  /** Force a backend (tests + the file-isolation path). */
  forceBackend?: KeychainBackend;
}

// Once a backend refuses us in this process (missing binary, no session bus,
// cancelled ACL), stop hammering it — that is what triggers cascades of system
// dialogs. The file fallback handles the rest of the process lifetime.
const disabledBackends = new Set<KeychainBackend>();

function isDarwin(): boolean {
  return platform() === "darwin";
}
function isLinux(): boolean {
  return platform() === "linux";
}
function isWindows(): boolean {
  return platform() === "win32";
}

function defaultFallbackDir(opts?: SecretStoreOptions): string {
  if (opts?.fallbackDir) return opts.fallbackDir;
  const c = process.env.UNBROWSE_CONFIG_DIR?.trim();
  if (c) return c;
  return join(homedir(), ".unbrowse");
}

// ─── macOS: security(1) against the login keychain ──────────────────────────

function loginKeychainPath(): string {
  return join(homedir(), "Library", "Keychains", "login.keychain-db");
}

function macAvailable(): boolean {
  return isDarwin() && !disabledBackends.has("macos-keychain") && existsSync(loginKeychainPath());
}

function macGet(service: string, account: string): string | null {
  if (!macAvailable()) return null;
  const r = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", service, "-a", account, "-w", loginKeychainPath()],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    // status 44 = item not found (normal); any other failure → stop trying.
    if (r.status !== 44) disabledBackends.add("macos-keychain");
    return null;
  }
  const v = (r.stdout ?? "").trim();
  return v.length > 0 ? v : null;
}

function macSet(service: string, account: string, value: string): boolean {
  if (!macAvailable()) return false;
  // `-U` upsert (update in place) + `-A` allow-any-app so sibling spawns read
  // without an ACL prompt. This is the signer's proven shape — do NOT
  // delete-then-add: a freshly-created item can't be read back in the SAME
  // process non-interactively (the ACL won't settle without a TTY), which is
  // fine in production (the key is minted once, read in later processes).
  const r = spawnSync(
    "/usr/bin/security",
    ["add-generic-password", "-s", service, "-a", account, "-w", value, "-U", "-A", loginKeychainPath()],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    disabledBackends.add("macos-keychain");
    return false;
  }
  return true;
}

function macRemove(service: string, account: string): boolean {
  if (!macAvailable()) return false;
  const r = spawnSync(
    "/usr/bin/security",
    ["delete-generic-password", "-s", service, "-a", account, loginKeychainPath()],
    { encoding: "utf8" },
  );
  return r.status === 0;
}

// ─── Linux: secret-tool (Secret Service API) ────────────────────────────────

function secretToolAvailable(): boolean {
  if (!isLinux() || disabledBackends.has("secret-service")) return false;
  const r = spawnSync("secret-tool", ["--version"], { encoding: "utf8" });
  if (r.status !== 0 && r.error) {
    disabledBackends.add("secret-service");
    return false;
  }
  return r.status === 0;
}

function secretToolGet(service: string, account: string): string | null {
  if (!secretToolAvailable()) return null;
  const r = spawnSync(
    "secret-tool",
    ["lookup", "service", service, "account", account],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null; // not found / locked
  const v = (r.stdout ?? "").replace(/\n$/, "");
  return v.length > 0 ? v : null;
}

function secretToolSet(service: string, account: string, value: string): boolean {
  if (!secretToolAvailable()) return false;
  const r = spawnSync(
    "secret-tool",
    ["store", "--label", `${service}:${account}`, "service", service, "account", account],
    { input: value, encoding: "utf8" },
  );
  if (r.status !== 0) {
    disabledBackends.add("secret-service");
    return false;
  }
  return true;
}

function secretToolRemove(service: string, account: string): boolean {
  if (!secretToolAvailable()) return false;
  const r = spawnSync("secret-tool", ["clear", "service", service, "account", account], { encoding: "utf8" });
  return r.status === 0;
}

// ─── Windows: DPAPI (ProtectedData, CurrentUser) via PowerShell ──────────────

function powershellAvailable(): boolean {
  if (!isWindows() || disabledBackends.has("windows-dpapi")) return false;
  return true; // powershell.exe ships with Windows; spawn errors fall back below
}

function dpapiBlobPath(dir: string, service: string, account: string): string {
  return join(dir, "secrets", `${sanitize(service)}__${sanitize(account)}.dpapi`);
}

function runPowershell(script: string, input?: string): { status: number; stdout: string } {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { input, encoding: "utf8" },
  );
  return { status: r.status ?? 1, stdout: (r.stdout ?? "").trim() };
}

function dpapiSet(dir: string, service: string, account: string, value: string): boolean {
  if (!powershellAvailable()) return false;
  // Protect the UTF-8 bytes under the CurrentUser scope; emit base64.
  const script =
    "$v=[Console]::In.ReadToEnd();" +
    "$b=[Text.Encoding]::UTF8.GetBytes($v);" +
    "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
    "[Convert]::ToBase64String($p)";
  const r = runPowershell(script, value);
  if (r.status !== 0 || !r.stdout) {
    disabledBackends.add("windows-dpapi");
    return false;
  }
  ensureDir(join(dir, "secrets"));
  writeFileSync(dpapiBlobPath(dir, service, account), r.stdout, { mode: 0o600 });
  return true;
}

function dpapiGet(dir: string, service: string, account: string): string | null {
  if (!powershellAvailable()) return null;
  const path = dpapiBlobPath(dir, service, account);
  if (!existsSync(path)) return null;
  const blob = readFileSync(path, "utf8").trim();
  const script =
    `$p=[Convert]::FromBase64String('${blob}');` +
    "$b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser');" +
    "[Text.Encoding]::UTF8.GetString($b)";
  const r = runPowershell(script);
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout;
}

function dpapiRemove(dir: string, service: string, account: string): boolean {
  const path = dpapiBlobPath(dir, service, account);
  if (!existsSync(path)) return true;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ─── Fallback: AES-256-GCM encrypted file ───────────────────────────────────

function deriveFileKey(opts?: SecretStoreOptions): Buffer {
  const passphrase =
    opts?.passphrase ?? process.env.UNBROWSE_WALLET_PASSPHRASE ?? `unbrowse:${homedir()}`;
  // Fixed salt → deterministic: the same passphrase unlocks across runs.
  return scryptSync(passphrase, "unbrowse-secret-store-v1", 32);
}

function filePath(dir: string, service: string, account: string): string {
  return join(dir, "secrets", `${sanitize(service)}__${sanitize(account)}.enc`);
}

function fileGet(dir: string, service: string, account: string, opts?: SecretStoreOptions): string | null {
  const path = filePath(dir, service, account);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path);
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", deriveFileKey(opts), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

function fileSet(dir: string, service: string, account: string, value: string, opts?: SecretStoreOptions): boolean {
  try {
    ensureDir(join(dir, "secrets"));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", deriveFileKey(opts), iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), ct]);
    writeFileSync(filePath(dir, service, account), blob, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function fileRemove(dir: string, service: string, account: string): boolean {
  const path = filePath(dir, service, account);
  if (!existsSync(path)) return true;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_");
}
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** The backend that would handle a call right now (after availability probes). */
export function activeBackend(opts?: SecretStoreOptions): KeychainBackend {
  if (opts?.forceBackend) return opts.forceBackend;
  if (macAvailable()) return "macos-keychain";
  if (secretToolAvailable()) return "secret-service";
  if (powershellAvailable()) return "windows-dpapi";
  return "encrypted-file";
}

// ─── public API ─────────────────────────────────────────────────────────────

/** Read a secret string, or null if absent / store unavailable. */
export function getSecret(service: string, account: string, opts?: SecretStoreOptions): string | null {
  const dir = defaultFallbackDir(opts);
  switch (activeBackend(opts)) {
    case "macos-keychain": return macGet(service, account) ?? fileGet(dir, service, account, opts);
    case "secret-service": return secretToolGet(service, account) ?? fileGet(dir, service, account, opts);
    case "windows-dpapi": return dpapiGet(dir, service, account) ?? fileGet(dir, service, account, opts);
    default: return fileGet(dir, service, account, opts);
  }
}

/** Persist a secret string to the active backend. Returns false only if every path failed. */
export function setSecret(service: string, account: string, value: string, opts?: SecretStoreOptions): boolean {
  const dir = defaultFallbackDir(opts);
  // Idempotent write: if the store already holds this EXACT value, do not re-write.
  // A redundant native write is what re-triggers macOS's "change access permissions"
  // dialog (`add-generic-password -U -A` modifies an existing item's ACL every call),
  // so callers that re-persist an unchanged key (wallet-first sync, boot) no longer
  // surface a prompt. A genuine value change still falls through and writes.
  if (getSecret(service, account, opts) === value) return true;
  switch (activeBackend(opts)) {
    case "macos-keychain": if (macSet(service, account, value)) return true; break;
    case "secret-service": if (secretToolSet(service, account, value)) return true; break;
    case "windows-dpapi": if (dpapiSet(dir, service, account, value)) return true; break;
    default: break;
  }
  // Last resort — never lose the write.
  return fileSet(dir, service, account, value, opts);
}

/** Delete a secret from every store it might live in. */
export function removeSecret(service: string, account: string, opts?: SecretStoreOptions): boolean {
  const dir = defaultFallbackDir(opts);
  const a = activeBackend(opts) === "macos-keychain" ? macRemove(service, account) : true;
  const b = activeBackend(opts) === "secret-service" ? secretToolRemove(service, account) : true;
  const c = activeBackend(opts) === "windows-dpapi" ? dpapiRemove(dir, service, account) : true;
  const d = fileRemove(dir, service, account);
  return a && b && c && d;
}

// ─── shared adapter helpers ─────────────────────────────────────────────────

/**
 * The default store options for an adapter secret. An isolated run (a test via
 * UNBROWSE_WALLET_DIR, an explicit UNBROWSE_DISABLE_KEYCHAIN) is pinned to the
 * encrypted-file backend at the isolated dir so it can NEVER read or overwrite
 * the real user's OS-keychain secrets. Otherwise the platform-native backend
 * (macOS keychain / Linux secret-service / Windows DPAPI) handles it.
 */
export function defaultSecretOpts(): SecretStoreOptions {
  const isolated =
    !!process.env.UNBROWSE_WALLET_DIR?.trim() ||
    process.env.UNBROWSE_DISABLE_KEYCHAIN === "1";
  const dir =
    process.env.UNBROWSE_WALLET_DIR?.trim() ||
    process.env.UNBROWSE_CONFIG_DIR?.trim() ||
    join(homedir(), ".unbrowse");
  return isolated ? { forceBackend: "encrypted-file", fallbackDir: dir } : { fallbackDir: dir };
}

/**
 * Resolve an adapter secret with the SAME migration shape the x402 signer uses:
 * prefer the unified store; on a miss, read the legacy source (env var /
 * plaintext file) and re-persist it into the store so the next read is native
 * and password-free. An existing secret is never orphaned.
 *
 * `legacy` returns the secret from its old home, or null if it isn't there.
 */
export function resolveSecret(
  service: string,
  account: string,
  legacy: () => string | null,
  opts: SecretStoreOptions = defaultSecretOpts(),
): string | null {
  const fromStore = getSecret(service, account, opts);
  if (fromStore) return fromStore;
  const migrated = legacy();
  if (migrated) {
    try { setSecret(service, account, migrated, opts); } catch { /* best-effort migration */ }
    return migrated;
  }
  return null;
}

/** Test-only: clear the per-process backend-disabled guard. */
export function _resetBackendGuards(): void {
  disabledBackends.clear();
}
