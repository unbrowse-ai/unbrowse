/**
 * Credential Vault — Encrypted local storage for API auth credentials.
 *
 * Uses SQLite (via CLI) + AES-256-GCM encryption with a key stored in macOS Keychain.
 * Generated skills store auth in the vault instead of plain text auth.json.
 * The vault key never touches disk — it lives in the OS keychain.
 *
 * Schema:
 *   credentials(service, base_url, auth_method, headers_enc, cookies_enc,
 *               extra_enc, created_at, updated_at, expires_at, notes)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VAULT_DIR = join(homedir(), ".clawdbot", "unbrowse");
const VAULT_DB = join(VAULT_DIR, "vault.db");
const KEYCHAIN_SERVICE = "unbrowse-vault";
const CIPHER = "aes-256-gcm";

/** Retrieve the vault encryption key from macOS Keychain, or create one if missing. */
function getVaultKey(): Buffer {
  const user = process.env.USER || "unbrowse";

  try {
    const keyHex = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${user}" -w 2>/dev/null`,
      { encoding: "utf-8" },
    ).trim();
    return Buffer.from(keyHex, "hex");
  } catch {
    // Key doesn't exist — create a new 256-bit key and store in Keychain
    const newKey = randomBytes(32);
    const keyHex = newKey.toString("hex");

    try {
      execSync(
        `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${user}" -w "${keyHex}" -U`,
        { encoding: "utf-8" }
      );
      return newKey;
    } catch (addErr) {
      throw new Error(
        `Could not create vault key in Keychain: ${addErr}`,
      );
    }
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

/** Escape a string for safe use in SQLite queries (single quotes). */
function sqlEscape(str: string): string {
  return str.replace(/'/g, "''");
}

/** Escape a shell argument for safe use in shell commands. */
function shellEscape(str: string): string {
  // Use single quotes for shell safety and escape any internal single quotes
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/** Run a SQLite query and return parsed JSON rows. */
function sqlQuery(dbPath: string, query: string): any[] {
  try {
    const result = execSync(
      `sqlite3 -json "${dbPath}" ${shellEscape(query)}`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    if (!result) return [];
    return JSON.parse(result);
  } catch (err: any) {
    // sqlite3 -json returns empty string for no results
    if (err.stdout === "" || err.stdout?.trim() === "") return [];
    throw err;
  }
}

/** Run a SQLite statement (INSERT/UPDATE/DELETE). */
function sqlRun(dbPath: string, statement: string): void {
  execSync(`sqlite3 "${dbPath}" ${shellEscape(statement)}`, { encoding: "utf-8" });
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
  private dbPath: string;
  private key: Buffer;

  constructor(dbPath = VAULT_DB) {
    this.dbPath = dbPath;

    // Auto-create vault directory and database if missing
    const vaultDir = join(homedir(), ".clawdbot", "unbrowse");
    if (!existsSync(vaultDir)) {
      mkdirSync(vaultDir, { recursive: true });
    }

    if (!existsSync(dbPath)) {
      // Create the database with schema
      execSync(`sqlite3 "${dbPath}" "CREATE TABLE IF NOT EXISTS credentials (
        service TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        headers_enc TEXT,
        cookies_enc TEXT,
        extra_enc TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT,
        notes TEXT
      )"`, { encoding: "utf-8" });
    }

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
    const headersEnc = data.headers ? encrypt(JSON.stringify(data.headers), this.key) : "";
    const cookiesEnc = data.cookies ? encrypt(JSON.stringify(data.cookies), this.key) : "";
    const extraEnc = data.extra ? encrypt(JSON.stringify(data.extra), this.key) : "";
    const expiresAt = data.expiresAt || "";
    const notes = data.notes || "";

    const stmt = `INSERT INTO credentials (service, base_url, auth_method, headers_enc, cookies_enc, extra_enc, expires_at, notes, updated_at)
       VALUES ('${sqlEscape(service)}', '${sqlEscape(data.baseUrl)}', '${sqlEscape(data.authMethod)}', '${sqlEscape(headersEnc)}', '${sqlEscape(cookiesEnc)}', '${sqlEscape(extraEnc)}', '${sqlEscape(expiresAt)}', '${sqlEscape(notes)}', datetime('now'))
       ON CONFLICT(service) DO UPDATE SET
         base_url = excluded.base_url,
         auth_method = excluded.auth_method,
         headers_enc = excluded.headers_enc,
         cookies_enc = excluded.cookies_enc,
         extra_enc = excluded.extra_enc,
         expires_at = excluded.expires_at,
         notes = excluded.notes,
         updated_at = datetime('now')`;

    sqlRun(this.dbPath, stmt);
  }

  /** Get credentials for a service. */
  get(service: string): VaultEntry | null {
    const rows = sqlQuery(this.dbPath, `SELECT * FROM credentials WHERE service = '${sqlEscape(service)}'`);

    if (!rows.length) return null;
    const row = rows[0];

    return {
      service: row.service,
      baseUrl: row.base_url,
      authMethod: row.auth_method,
      headers: row.headers_enc ? JSON.parse(decrypt(row.headers_enc, this.key)) : {},
      cookies: row.cookies_enc ? JSON.parse(decrypt(row.cookies_enc, this.key)) : {},
      extra: row.extra_enc ? JSON.parse(decrypt(row.extra_enc, this.key)) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at || undefined,
      notes: row.notes || undefined,
    };
  }

  /** List all stored services (without decrypting credentials). */
  list(): { service: string; baseUrl: string; authMethod: string; updatedAt: string; expiresAt?: string }[] {
    const rows = sqlQuery(this.dbPath, `SELECT service, base_url, auth_method, updated_at, expires_at FROM credentials ORDER BY updated_at DESC`);

    return rows.map((r: any) => ({
      service: r.service,
      baseUrl: r.base_url,
      authMethod: r.auth_method,
      updatedAt: r.updated_at,
      expiresAt: r.expires_at || undefined,
    }));
  }

  /** Delete credentials for a service. */
  delete(service: string): boolean {
    try {
      sqlRun(this.dbPath, `DELETE FROM credentials WHERE service = '${sqlEscape(service)}'`);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if a service has stored credentials. */
  has(service: string): boolean {
    const rows = sqlQuery(this.dbPath, `SELECT 1 FROM credentials WHERE service = '${sqlEscape(service)}'`);
    return rows.length > 0;
  }

  /** Check if credentials are expired. */
  isExpired(service: string): boolean {
    const rows = sqlQuery(this.dbPath, `SELECT expires_at FROM credentials WHERE service = '${sqlEscape(service)}'`);
    if (!rows.length || !rows[0].expires_at) return false;
    return new Date(rows[0].expires_at) < new Date();
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
    // No-op for CLI-based approach
  }
}
