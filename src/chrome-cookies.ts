/**
 * Chrome Cookie Reader — Read cookies directly from Chrome's cookie database.
 *
 * Reads cookies from Chrome's SQLite database and decrypts them using
 * the key stored in macOS Keychain ("Chrome Safe Storage").
 *
 * This allows unbrowse to use the user's existing Chrome sessions without
 * needing to attach extensions or launch separate browsers.
 */

import { execSync } from "node:child_process";
import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";

const CHROME_USER_DATA_DIR = join(homedir(), "Library/Application Support/Google/Chrome");

/** Get the last used Chrome profile directory name. */
function getLastUsedProfile(): string {
  try {
    const localStatePath = join(CHROME_USER_DATA_DIR, "Local State");
    if (existsSync(localStatePath)) {
      const { readFileSync } = require("node:fs");
      const localState = JSON.parse(readFileSync(localStatePath, "utf-8"));
      const lastUsed = localState?.profile?.last_used;
      if (lastUsed && typeof lastUsed === "string") {
        return lastUsed;
      }
    }
  } catch { /* use Default */ }
  return "Default";
}

function getChromeCookiePath(): string {
  const profile = getLastUsedProfile();
  return join(CHROME_USER_DATA_DIR, profile, "Cookies");
}

const CHROME_KEYCHAIN_SERVICE = "Chrome Safe Storage";
const CHROME_KEYCHAIN_ACCOUNT = "Chrome";

/** Get Chrome's encryption key from macOS Keychain. */
function getChromeKey(): Buffer {
  try {
    const password = execSync(
      `security find-generic-password -s "${CHROME_KEYCHAIN_SERVICE}" -a "${CHROME_KEYCHAIN_ACCOUNT}" -w 2>/dev/null`,
      { encoding: "utf-8" }
    ).trim();

    // Chrome uses PBKDF2 with the keychain password
    // Iterations: 1003, Key length: 16 bytes, Salt: "saltysalt"
    return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  } catch {
    throw new Error("Chrome keychain password not found. Is Chrome installed?");
  }
}

/** Decrypt a Chrome cookie value (v10 format on macOS). */
function decryptCookie(encryptedValue: Buffer, key: Buffer): string {
  if (encryptedValue.length === 0) return "";

  // Check for v10 prefix (used on macOS)
  const prefix = encryptedValue.subarray(0, 3).toString("utf-8");
  if (prefix !== "v10") {
    // Not encrypted or different format - try as plaintext
    return encryptedValue.toString("utf-8");
  }

  // Chrome 80+ on macOS uses v10 + AES-128-GCM
  // Format: "v10" (3 bytes) + nonce (12 bytes) + ciphertext + auth tag (16 bytes)
  try {
    const nonce = encryptedValue.subarray(3, 15); // 12-byte nonce
    const tag = encryptedValue.subarray(encryptedValue.length - 16); // 16-byte auth tag
    const ciphertext = encryptedValue.subarray(15, encryptedValue.length - 16);

    const decipher = createDecipheriv("aes-128-gcm", key, nonce);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf-8");
  } catch {
    // Try legacy AES-128-CBC (older Chrome versions)
    try {
      const iv = Buffer.alloc(16, " ");
      const ciphertext = encryptedValue.subarray(3);

      const decipher = createDecipheriv("aes-128-cbc", key, iv);
      decipher.setAutoPadding(true);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      return decrypted.toString("utf-8");
    } catch {
      return "";
    }
  }
}

export interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
}

/**
 * Read cookies from Chrome for a specific domain.
 *
 * @param domain Domain to filter (e.g., "agoda.com" matches ".agoda.com" and "www.agoda.com")
 * @returns Object mapping cookie names to values
 */
export function readChromeCookies(domain: string): Record<string, string> {
  if (!existsSync(getChromeCookiePath())) {
    throw new Error(`Chrome cookie database not found: ${getChromeCookiePath()}`);
  }

  // Copy the database to avoid lock issues (Chrome locks it while running)
  const tmpPath = `/tmp/chrome-cookies-${Date.now()}.db`;
  copyFileSync(getChromeCookiePath(), tmpPath);

  try {
    const key = getChromeKey();

    // Query cookies using sqlite3 CLI (bun:sqlite can't open locked files even with copy)
    // We need to get both the name and encrypted_value as hex
    const domainPattern = `%${domain}%`;
    const result = execSync(
      `sqlite3 "${tmpPath}" "SELECT name, hex(encrypted_value), host_key FROM cookies WHERE host_key LIKE '${domainPattern}'"`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    const cookies: Record<string, string> = {};

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;

      const parts = line.split("|");
      if (parts.length < 2) continue;

      const name = parts[0];
      const encryptedHex = parts[1];

      if (!encryptedHex) continue;

      const encryptedValue = Buffer.from(encryptedHex, "hex");
      const value = decryptCookie(encryptedValue, key);

      if (value) {
        cookies[name] = value;
      }
    }

    return cookies;
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read all cookies from Chrome for a specific domain with full metadata.
 */
export function readChromeCookiesFull(domain: string): ChromeCookie[] {
  if (!existsSync(getChromeCookiePath())) {
    throw new Error(`Chrome cookie database not found: ${getChromeCookiePath()}`);
  }

  const tmpPath = `/tmp/chrome-cookies-${Date.now()}.db`;
  copyFileSync(getChromeCookiePath(), tmpPath);

  try {
    const key = getChromeKey();
    const domainPattern = `%${domain}%`;

    const result = execSync(
      `sqlite3 "${tmpPath}" "SELECT name, hex(encrypted_value), host_key, path, expires_utc, is_httponly, is_secure FROM cookies WHERE host_key LIKE '${domainPattern}'"`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    );

    const cookies: ChromeCookie[] = [];

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;

      const parts = line.split("|");
      if (parts.length < 7) continue;

      const [name, encryptedHex, hostKey, path, expiresUtc, isHttpOnly, isSecure] = parts;

      if (!encryptedHex) continue;

      const encryptedValue = Buffer.from(encryptedHex, "hex");
      const value = decryptCookie(encryptedValue, key);

      if (value) {
        cookies.push({
          name,
          value,
          domain: hostKey,
          path: path || "/",
          expires: parseInt(expiresUtc) || 0,
          httpOnly: isHttpOnly === "1",
          secure: isSecure === "1",
        });
      }
    }

    return cookies;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Check if Chrome cookies are available for reading.
 */
export function chromeCookiesAvailable(): boolean {
  if (!existsSync(getChromeCookiePath())) return false;

  try {
    getChromeKey();
    return true;
  } catch {
    return false;
  }
}
