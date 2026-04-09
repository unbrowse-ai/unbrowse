/**
 * Extract cookies directly from Chrome/Firefox SQLite databases.
 * Adapted from github.com/jawond/bird — generalized for any domain.
 *
 * Chrome cookies are AES-128-CBC encrypted with a key from the macOS keychain.
 * Firefox cookies are stored unencrypted.
 *
 * This avoids needing to launch a browser or close Chrome (reads a copy of the DB).
 */

import { execSync, execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { getRegistrableDomain, isDomainMatch } from "../domain.js";

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  expires: number;
}

export interface ExtractionResult {
  cookies: BrowserCookie[];
  source: string | null;
  warnings: string[];
}

export type BrowserSource = "auto" | "firefox" | "chrome" | "chromium";

export interface ChromiumCookieSourceOptions {
  profile?: string;
  userDataDir?: string;
  cookieDbPath?: string;
  safeStorageService?: string;
  browserName?: string;
}

export interface ExtractBrowserCookiesOptions {
  browser?: BrowserSource;
  chromeProfile?: string;
  firefoxProfile?: string;
  chromium?: ChromiumCookieSourceOptions;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getChromeUserDataDir(): string {
  const home = homedir();
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (platform() === "win32") {
    const appData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(appData, "Google", "Chrome", "User Data");
  }
  return join(home, ".config", "google-chrome");
}

export function resolveChromiumCookiesPath(opts?: ChromiumCookieSourceOptions): string | null {
  if (opts?.cookieDbPath) {
    return opts.cookieDbPath.replace(/^~\//, homedir() + "/");
  }

  const profileDir = opts?.profile || "Default";
  const userDataDir = (opts?.userDataDir || getChromeUserDataDir()).replace(/^~\//, homedir() + "/");
  const candidates = [
    join(userDataDir, profileDir, "Network", "Cookies"),
    join(userDataDir, profileDir, "Cookies"),
    join(userDataDir, "Network", "Cookies"),
    join(userDataDir, "Cookies"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? null;
}

function getFirefoxProfilesRoot(): string | null {
  const home = homedir();
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Firefox", "Profiles");
  }
  if (platform() === "linux") {
    return join(home, ".mozilla", "firefox");
  }
  if (platform() === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return join(appData, "Mozilla", "Firefox", "Profiles");
  }
  return null;
}

function pickFirefoxProfile(profilesRoot: string, profile?: string): string | null {
  if (profile) {
    const candidate = join(profilesRoot, profile, "cookies.sqlite");
    return existsSync(candidate) ? candidate : null;
  }
  const entries = readdirSync(profilesRoot, { withFileTypes: true });
  const defaultRelease = entries.find((e) => e.isDirectory() && e.name.includes("default-release"));
  const targetDir = defaultRelease?.name ?? entries.find((e) => e.isDirectory())?.name;
  if (!targetDir) return null;
  const candidate = join(profilesRoot, targetDir, "cookies.sqlite");
  return existsSync(candidate) ? candidate : null;
}

function getFirefoxCookiesPath(profile?: string): string | null {
  const profilesRoot = getFirefoxProfilesRoot();
  if (!profilesRoot || !existsSync(profilesRoot)) return null;
  return pickFirefoxProfile(profilesRoot, profile);
}

// ---------------------------------------------------------------------------
// Chrome decryption (macOS — uses keychain + PBKDF2 + AES-128-CBC)
// ---------------------------------------------------------------------------

const _chromiumKeyCache = new Map<string, Buffer>();

function getChromiumKeychainServiceName(opts?: ChromiumCookieSourceOptions): string {
  if (opts?.safeStorageService) return opts.safeStorageService;
  return `${opts?.browserName || "Chrome"} Safe Storage`;
}

function getChromiumDecryptionKey(opts?: ChromiumCookieSourceOptions): Buffer | null {
  const service = getChromiumKeychainServiceName(opts);
  const cached = _chromiumKeyCache.get(service);
  if (cached) return cached;
  if (platform() !== "darwin") return null; // TODO: Linux/Windows support

  try {
    const keyOutput = execFileSync(
      "security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!keyOutput) return null;

    const derived = pbkdf2Sync(keyOutput, "saltysalt", 1003, 16, "sha1");
    _chromiumKeyCache.set(service, derived);
    return derived;
  } catch {
    return null;
  }
}

function decryptChromiumValue(encryptedHex: string, opts?: ChromiumCookieSourceOptions): string | null {
  try {
    const buf = Buffer.from(encryptedHex, "hex");
    if (buf.length < 4) return null;

    const version = buf.subarray(0, 3).toString("utf8");
    if (version !== "v10" && version !== "v11") {
      // Not encrypted
      return buf.toString("utf8");
    }

    const key = getChromiumDecryptionKey(opts);
    if (!key) return null;

    const payload = buf.subarray(3);

    // Modern Chrome (v131+) prepends a 32-byte header (key derivation nonce)
    // before the actual AES-128-CBC ciphertext.  The second 16-byte block of
    // the raw payload acts as the CBC IV for the remaining ciphertext.
    // Fallback: legacy format has no header (IV = 16 × 0x20 space bytes).
    if (payload.length >= 48) {
      try {
        const iv = payload.subarray(16, 32);
        const encrypted = payload.subarray(32);
        const decipher = createDecipheriv("aes-128-cbc", key, iv);
        decipher.setAutoPadding(true);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const val = decrypted.toString("utf8").replace(/[^\x20-\x7E]/g, "");
        if (val.length > 0) return val;
      } catch { /* fall through to legacy */ }
    }

    // Legacy format: IV = 16 bytes of space, ciphertext starts right after version
    const iv = Buffer.alloc(16, 0x20);
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(payload), decipher.final()]);
    return decrypted.toString("utf8").replace(/[^\x20-\x7E]/g, "");
  } catch {
    return null;
  }
}

export function decodeChromiumCookieValue(rawValue: string, encryptedHex: string, opts?: ChromiumCookieSourceOptions): string | null {
  if (rawValue) return rawValue;
  if (!encryptedHex) return null;
  return decryptChromiumValue(encryptedHex, opts);
}

// ---------------------------------------------------------------------------
// SQLite helpers — copy DB to temp dir, query, cleanup
// ---------------------------------------------------------------------------

function withTempCopy<T>(dbPath: string, fn: (tempPath: string) => T): T {
  const tempDir = mkdtempSync(join(tmpdir(), "unbrowse-cookies-"));
  const tempDb = join(tempDir, "cookies.db");
  try {
    copyFileSync(dbPath, tempDb);
    // Copy WAL/SHM so we get the latest committed state even while Chrome is open
    for (const ext of ["-wal", "-shm"]) {
      const src = dbPath + ext;
      if (existsSync(src)) copyFileSync(src, tempDb + ext);
    }
    return fn(tempDb);
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function sqliteQuery(dbPath: string, sql: string): string {
  return execFileSync("sqlite3", ["-separator", "|", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

// ---------------------------------------------------------------------------
// Domain matching helpers for SQL WHERE clauses
// ---------------------------------------------------------------------------

function buildDomainWhereClause(domain: string, column: string): string {
  const reg = getRegistrableDomain(domain);
  // Match exact domains: .example.com, example.com, plus common subdomains
  const variants = new Set([
    reg,
    `.${reg}`,
    domain,
    `.${domain}`,
    `www.${reg}`,
    `.www.${reg}`,
  ]);
  // Use parameterized-safe quoting: reject any domain containing single quotes
  for (const d of variants) {
    if (d.includes("'")) throw new Error(`Invalid domain for cookie query: ${d}`);
  }
  const escaped = [...variants].map((d) => `'${d}'`);
  const likeReg = reg.includes("'") ? reg : reg;
  const likePattern = `'%.${likeReg}'`;
  return `(${column} IN (${escaped.join(", ")}) OR ${column} LIKE ${likePattern})`;
}

// ---------------------------------------------------------------------------
// Chrome extraction
// ---------------------------------------------------------------------------

export function extractFromChrome(
  domain: string,
  opts?: { profile?: string },
): ExtractionResult {
  return extractFromChromium(domain, {
    profile: opts?.profile,
    browserName: "Chrome",
  });
}

export function extractFromChromium(
  domain: string,
  opts?: ChromiumCookieSourceOptions,
): ExtractionResult {
  const warnings: string[] = [];
  const dbPath = resolveChromiumCookiesPath(opts);
  const sourceLabel = opts?.browserName || "Chromium";

  if (!dbPath || !existsSync(dbPath)) {
    warnings.push(`${sourceLabel} cookies DB not found${dbPath ? ` at ${dbPath}` : ""}`);
    return { cookies: [], source: null, warnings };
  }

  try {
    const cookies = withTempCopy(dbPath, (tempDb) => {
      const where = buildDomainWhereClause(domain, "host_key");
      const sql = `SELECT name, value, hex(encrypted_value) as ev, host_key, path, is_secure, is_httponly, samesite, expires_utc FROM cookies WHERE ${where};`;
      const rows = sqliteQuery(tempDb, sql);
      if (!rows) return [];

      const results: BrowserCookie[] = [];
      for (const line of rows.split("\n")) {
        const parts = line.split("|");
        if (parts.length < 9) continue;
        const [name, rawValue, encHex, host, cookiePath, secure, httpOnly, sameSite, expiresUtc] = parts;
        const value = decodeChromiumCookieValue(rawValue, encHex, opts);
        if (!value) continue;

        results.push({
          name,
          value,
          domain: host,
          path: cookiePath || "/",
          secure: secure === "1",
          httpOnly: httpOnly === "1",
          sameSite: sameSite === "0" ? "None" : sameSite === "1" ? "Lax" : "Strict",
          // Chrome stores expiry as microseconds since 1601-01-01
          expires: expiresUtc === "0" ? -1 : Math.floor(
            (Number(expiresUtc) - 11644473600000000) / 1000000
          ),
        });
      }
      return results;
    });

    const source = opts?.cookieDbPath
      ? `${sourceLabel} cookie DB "${dbPath}"`
      : opts?.userDataDir
        ? `${sourceLabel} user data "${opts.userDataDir}"${opts.profile ? ` profile "${opts.profile}"` : ""}`
        : opts?.profile
          ? `${sourceLabel} profile "${opts.profile}"`
          : `${sourceLabel} default profile`;
    if (cookies.length === 0) {
      warnings.push(`No cookies for ${domain} found in ${source}`);
    }
    log("auth", `extracted ${cookies.length} cookies for ${domain} from ${source}`);
    return { cookies, source: cookies.length > 0 ? source : null, warnings };
  } catch (err) {
    warnings.push(`${sourceLabel} extraction failed: ${err instanceof Error ? err.message : err}`);
    return { cookies: [], source: null, warnings };
  }
}

// ---------------------------------------------------------------------------
// Firefox extraction
// ---------------------------------------------------------------------------

export function extractFromFirefox(
  domain: string,
  opts?: { profile?: string },
): ExtractionResult {
  const warnings: string[] = [];
  const dbPath = getFirefoxCookiesPath(opts?.profile);

  if (!dbPath) {
    warnings.push("Firefox cookies DB not found");
    return { cookies: [], source: null, warnings };
  }

  try {
    const cookies = withTempCopy(dbPath, (tempDb) => {
      const where = buildDomainWhereClause(domain, "host");
      const sql = `SELECT name, value, host, path, isSecure, isHttpOnly, sameSite, expiry FROM moz_cookies WHERE ${where};`;
      const rows = sqliteQuery(tempDb, sql);
      if (!rows) return [];

      const results: BrowserCookie[] = [];
      for (const line of rows.split("\n")) {
        const parts = line.split("|");
        if (parts.length < 8) continue;
        const [name, value, host, cookiePath, secure, httpOnly, sameSite, expiry] = parts;
        if (!name || !value) continue;

        results.push({
          name,
          value,
          domain: host,
          path: cookiePath || "/",
          secure: secure === "1",
          httpOnly: httpOnly === "1",
          sameSite: sameSite === "0" ? "None" : sameSite === "1" ? "Lax" : "Strict",
          expires: Number(expiry) || -1,
        });
      }
      return results;
    });

    const source = opts?.profile ? `Firefox profile "${opts.profile}"` : "Firefox default profile";
    if (cookies.length === 0) {
      warnings.push(`No cookies for ${domain} found in ${source}`);
    }
    log("auth", `extracted ${cookies.length} cookies for ${domain} from ${source}`);
    return { cookies, source: cookies.length > 0 ? source : null, warnings };
  } catch (err) {
    warnings.push(`Firefox extraction failed: ${err instanceof Error ? err.message : err}`);
    return { cookies: [], source: null, warnings };
  }
}

// ---------------------------------------------------------------------------
// Unified extraction — tries Firefox first, then Chrome (bird's priority)
// ---------------------------------------------------------------------------

export function extractBrowserCookies(
  domain: string,
  opts?: ExtractBrowserCookiesOptions,
): ExtractionResult {
  if (opts?.browser === "firefox") {
    return extractFromFirefox(domain, { profile: opts.firefoxProfile });
  }

  if (opts?.browser === "chrome") {
    return extractFromChrome(domain, { profile: opts.chromeProfile });
  }

  if (opts?.browser === "chromium") {
    return extractFromChromium(domain, opts.chromium);
  }

  // Try Firefox first (no decryption needed, more reliable)
  const ff = extractFromFirefox(domain, { profile: opts?.firefoxProfile });
  if (ff.cookies.length > 0) return ff;

  // If caller provided an explicit Chromium-family source, try that next.
  if (opts?.chromium?.cookieDbPath || opts?.chromium?.userDataDir) {
    const chromium = extractFromChromium(domain, opts.chromium);
    chromium.warnings.push(...ff.warnings);
    return chromium;
  }

  // Fall back to Chrome
  const chrome = extractFromChrome(domain, { profile: opts?.chromeProfile });
  chrome.warnings.push(...ff.warnings);
  return chrome;
}
