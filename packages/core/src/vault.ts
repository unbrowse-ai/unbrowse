/**
 * Credential Vault — encrypted local storage for API auth credentials.
 *
 * Security-hardened build: no shell/OS keychain invocations.
 * Uses AES-256-GCM with a local key file protected by filesystem permissions.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VAULT_DIR = join(homedir(), ".openclaw", "unbrowse");
const VAULT_DB = join(VAULT_DIR, "vault.db");
const VAULT_KEY = join(VAULT_DIR, "vault.key");
const CIPHER = "aes-256-gcm";

/** Stored credential row. */
export interface VaultEntry {
  service: string;
  baseUrl: string;
  authMethod: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  extra: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  notes?: string;
}

type VaultRow = {
  service: string;
  base_url: string;
  auth_method: string;
  headers_enc: string;
  cookies_enc: string;
  extra_enc: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  notes?: string;
};

type VaultFile = {
  version: number;
  rows: Record<string, VaultRow>;
};

function ensureDir(): void {
  if (!existsSync(VAULT_DIR)) {
    mkdirSync(VAULT_DIR, { recursive: true });
  }
}

function ensureKey(): Buffer {
  ensureDir();

  if (existsSync(VAULT_KEY)) {
    const hex = readFileSync(VAULT_KEY, "utf-8").trim();
    if (hex.length >= 64) {
      return Buffer.from(hex, "hex");
    }
  }

  const key = randomBytes(32);
  writeFileSync(VAULT_KEY, key.toString("hex"), { mode: 0o600 });
  chmodSync(VAULT_KEY, 0o600);
  return key;
}

function readVaultFile(path: string): VaultFile {
  if (!existsSync(path)) {
    return { version: 1, rows: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as VaultFile;
    if (parsed && typeof parsed === "object" && parsed.rows && typeof parsed.rows === "object") {
      return parsed;
    }
  } catch {
    // fall through
  }

  return { version: 1, rows: {} };
}

function writeVaultFile(path: string, file: VaultFile): void {
  ensureDir();
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Encrypt a string with AES-256-GCM. Returns base64(iv + tag + ciphertext). */
function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt a base64(iv + tag + ciphertext) string. */
function decrypt(packed: string, key: Buffer): string {
  if (!packed) return "";
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf-8");
}

/**
 * Credential Vault — encrypted local store for API auth.
 */
export class Vault {
  private dbPath: string;
  private key: Buffer;

  constructor(dbPath = VAULT_DB) {
    this.dbPath = dbPath;
    ensureDir();
    this.key = ensureKey();

    if (!existsSync(this.dbPath)) {
      writeVaultFile(this.dbPath, { version: 1, rows: {} });
    }
  }

  private readRows(): Record<string, VaultRow> {
    return readVaultFile(this.dbPath).rows;
  }

  private writeRows(rows: Record<string, VaultRow>): void {
    writeVaultFile(this.dbPath, { version: 1, rows });
  }

  /** Store credentials for a service (upsert). */
  store(
    service: string,
    data: {
      baseUrl: string;
      authMethod: string;
      headers?: Record<string, string>;
      cookies?: Record<string, string>;
      extra?: Record<string, string>;
      expiresAt?: string;
      notes?: string;
    },
  ): void {
    const rows = this.readRows();
    const existing = rows[service];
    const now = new Date().toISOString();

    rows[service] = {
      service,
      base_url: data.baseUrl,
      auth_method: data.authMethod,
      headers_enc: encrypt(JSON.stringify(data.headers ?? {}), this.key),
      cookies_enc: encrypt(JSON.stringify(data.cookies ?? {}), this.key),
      extra_enc: encrypt(JSON.stringify(data.extra ?? {}), this.key),
      created_at: existing?.created_at ?? now,
      updated_at: now,
      expires_at: data.expiresAt,
      notes: data.notes,
    };

    this.writeRows(rows);
  }

  /** Get credentials for a service. */
  get(service: string): VaultEntry | null {
    const row = this.readRows()[service];
    if (!row) return null;

    return {
      service: row.service,
      baseUrl: row.base_url,
      authMethod: row.auth_method,
      headers: row.headers_enc ? JSON.parse(decrypt(row.headers_enc, this.key)) : {},
      cookies: row.cookies_enc ? JSON.parse(decrypt(row.cookies_enc, this.key)) : {},
      extra: row.extra_enc ? JSON.parse(decrypt(row.extra_enc, this.key)) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      notes: row.notes,
    };
  }

  /** List all stored services (without decrypting credentials). */
  list(): { service: string; baseUrl: string; authMethod: string; updatedAt: string; expiresAt?: string }[] {
    const rows = Object.values(this.readRows());

    return rows
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map((r) => ({
        service: r.service,
        baseUrl: r.base_url,
        authMethod: r.auth_method,
        updatedAt: r.updated_at,
        expiresAt: r.expires_at,
      }));
  }

  /** Delete credentials for a service. */
  delete(service: string): boolean {
    const rows = this.readRows();
    if (!rows[service]) return false;
    delete rows[service];
    this.writeRows(rows);
    return true;
  }

  /** Check if a service has stored credentials. */
  has(service: string): boolean {
    return Boolean(this.readRows()[service]);
  }

  /** Check if credentials are expired. */
  isExpired(service: string): boolean {
    const row = this.readRows()[service];
    if (!row?.expires_at) return false;
    return new Date(row.expires_at) < new Date();
  }

  /** Export credentials as plain auth.json format (for generated skills). */
  exportAuthJson(service: string): string | null {
    const entry = this.get(service);
    if (!entry) return null;

    return JSON.stringify({
      service: entry.service,
      baseUrl: entry.baseUrl,
      authMethod: entry.authMethod,
      timestamp: entry.updatedAt,
      headers: entry.headers,
      cookies: entry.cookies,
      authInfo: entry.extra,
      notes: [`Exported from vault at ${new Date().toISOString()}`],
    }, null, 2);
  }

  close(): void {
    // No-op for file-based storage.
  }
}
