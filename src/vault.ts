/**
 * Credential Vault — Encrypted local storage for API auth credentials.
 *
 * Uses SQLite + AES-256-GCM encryption with a key stored in macOS Keychain.
 * Generated skills store auth in the vault instead of plain text auth.json.
 * The vault key never touches disk — it lives in the OS keychain.
 *
 * Schema:
 *   credentials(service, base_url, auth_method, headers_enc, cookies_enc,
 *               extra_enc, created_at, updated_at, expires_at, notes)
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import Database from "bun:sqlite";

const VAULT_DIR = join(homedir(), ".clawdbot", "unbrowse");
const VAULT_DB = join(VAULT_DIR, "vault.db");
const KEYCHAIN_SERVICE = "unbrowse-vault";
const CIPHER = "aes-256-gcm";

/** Retrieve the vault encryption key from macOS Keychain. */
function getVaultKey(): Buffer {
  try {
    const keyHex = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${process.env.USER}" -w 2>/dev/null`,
      { encoding: "utf-8" },
    ).trim();
    return Buffer.from(keyHex, "hex");
  } catch {
    throw new Error(
      "Vault key not found in Keychain. Run install.sh first.",
    );
  }
}

/** Encrypt a string with AES-256-GCM. Returns base64(iv + tag + ciphertext). */
function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: 12-byte IV + 16-byte auth tag + ciphertext
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt a base64(iv + tag + ciphertext) string. */
function decrypt(packed: string, key: Buffer): string {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf-8");
}

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

/**
 * Credential Vault — encrypted local store for API auth.
 *
 * Usage:
 *   const vault = new Vault();
 *   vault.store("stocktwits", { headers, cookies, ... });
 *   const creds = vault.get("stocktwits");
 *   vault.list();
 */
export class Vault {
  private db: Database;
  private key: Buffer;

  constructor(dbPath = VAULT_DB) {
    if (!existsSync(dbPath)) {
      throw new Error(`Vault DB not found: ${dbPath}. Run install.sh first.`);
    }
    this.db = new Database(dbPath);
    this.key = getVaultKey();
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
    const headersEnc = data.headers ? encrypt(JSON.stringify(data.headers), this.key) : null;
    const cookiesEnc = data.cookies ? encrypt(JSON.stringify(data.cookies), this.key) : null;
    const extraEnc = data.extra ? encrypt(JSON.stringify(data.extra), this.key) : null;

    this.db.run(
      `INSERT INTO credentials (service, base_url, auth_method, headers_enc, cookies_enc, extra_enc, expires_at, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(service) DO UPDATE SET
         base_url = excluded.base_url,
         auth_method = excluded.auth_method,
         headers_enc = excluded.headers_enc,
         cookies_enc = excluded.cookies_enc,
         extra_enc = excluded.extra_enc,
         expires_at = excluded.expires_at,
         notes = excluded.notes,
         updated_at = datetime('now')`,
      [service, data.baseUrl, data.authMethod, headersEnc, cookiesEnc, extraEnc, data.expiresAt ?? null, data.notes ?? null],
    );
  }

  /** Get credentials for a service. */
  get(service: string): VaultEntry | null {
    const row = this.db.query(
      `SELECT * FROM credentials WHERE service = ?`,
    ).get(service) as any;

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
      expiresAt: row.expires_at ?? undefined,
      notes: row.notes ?? undefined,
    };
  }

  /** List all stored services (without decrypting credentials). */
  list(): { service: string; baseUrl: string; authMethod: string; updatedAt: string; expiresAt?: string }[] {
    const rows = this.db.query(
      `SELECT service, base_url, auth_method, updated_at, expires_at FROM credentials ORDER BY updated_at DESC`,
    ).all() as any[];

    return rows.map((r) => ({
      service: r.service,
      baseUrl: r.base_url,
      authMethod: r.auth_method,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at ?? undefined,
    }));
  }

  /** Delete credentials for a service. */
  delete(service: string): boolean {
    const result = this.db.run(`DELETE FROM credentials WHERE service = ?`, [service]);
    return (result.changes ?? 0) > 0;
  }

  /** Check if a service has stored credentials. */
  has(service: string): boolean {
    const row = this.db.query(`SELECT 1 FROM credentials WHERE service = ?`).get(service);
    return row != null;
  }

  /** Check if credentials are expired. */
  isExpired(service: string): boolean {
    const row = this.db.query(
      `SELECT expires_at FROM credentials WHERE service = ?`,
    ).get(service) as any;
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
    this.db.close();
  }
}
