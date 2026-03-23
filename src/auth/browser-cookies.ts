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

export interface BrowserAuthSourceMeta {
  family: "chromium" | "firefox";
  browserName: string;
  source: string;
  userDataDir?: string;
  profile?: string;
  cookieDbPath?: string;
  safeStorageService?: string;
}

export interface ExtractionResult {
  cookies: BrowserCookie[];
  source: string | null;
  sourceMeta?: BrowserAuthSourceMeta | null;
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

type ChromiumBrowserCandidate = {
  name: string;
  userDataDir: string;
  safeStorageService: string;
  bundleId?: string;
};

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

export function extractDefaultBrowserBundleIdFromLaunchServicesData(data: unknown): string | null {
  const handlers = data && typeof data === "object" && Array.isArray((data as { LSHandlers?: unknown[] }).LSHandlers)
    ? (data as { LSHandlers: Array<Record<string, unknown>> }).LSHandlers
    : [];
  for (const scheme of ["https", "http"]) {
    const match = handlers.find((entry) => entry.LSHandlerURLScheme === scheme && typeof entry.LSHandlerRoleAll === "string");
    if (typeof match?.LSHandlerRoleAll === "string" && match.LSHandlerRoleAll.length > 0) {
      return match.LSHandlerRoleAll;
    }
  }
  return null;
}

function getMacDefaultBrowserBundleId(): string | null {
  if (platform() !== "darwin") return null;
  const plist = join(homedir(), "Library", "Preferences", "com.apple.LaunchServices.com.apple.launchservices.secure.plist");
  const fallbackPlist = join(homedir(), "Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist");
  const target = existsSync(plist) ? plist : fallbackPlist;
  if (!existsSync(target)) return null;
  try {
    const json = execFileSync("plutil", ["-convert", "json", "-o", "-", target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return extractDefaultBrowserBundleIdFromLaunchServicesData(JSON.parse(json));
  } catch {
    return null;
  }
}

export function prioritizeChromiumCandidates(
  sources: ChromiumBrowserCandidate[],
  preferredBundleId?: string | null,
): ChromiumBrowserCandidate[] {
  if (!preferredBundleId) return [...sources];
  const preferred = sources.find((source) => source.bundleId === preferredBundleId);
  if (!preferred) return [...sources];
  return [preferred, ...sources.filter((source) => source !== preferred)];
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

function inferChromiumProfileFromPath(
  dbPath: string,
  userDataDir?: string,
): string | undefined {
  if (!userDataDir) return undefined;
  const normalizedRoot = userDataDir.replace(/^~\//, homedir() + "/").replace(/\/+$/, "");
  const normalizedDbPath = dbPath.replace(/\/+$/, "");
  if (!normalizedDbPath.startsWith(`${normalizedRoot}/`)) return undefined;
  const rel = normalizedDbPath.slice(normalizedRoot.length + 1);
  const parts = rel.split("/");
  if (parts.length < 2) return undefined;
  if (parts[1] === "Cookies" || (parts[1] === "Network" && parts[2] === "Cookies")) {
    return parts[0];
  }
  return undefined;
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

function getFirefoxCookiesPath(profile?: string, profilesRoot?: string): string | null {
  const root = profilesRoot ?? getFirefoxProfilesRoot();
  if (!root || !existsSync(root)) return null;
  return pickFirefoxProfile(root, profile);
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
    userDataDir: getChromeUserDataDir(),
    browserName: "Chrome",
    safeStorageService: "Chrome Safe Storage",
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
    return { cookies: [], source: null, sourceMeta: null, warnings };
  }

  try {
    const resolvedProfile = opts?.profile || inferChromiumProfileFromPath(dbPath, opts?.userDataDir);
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
    const sourceMeta: BrowserAuthSourceMeta | null = cookies.length > 0
      ? {
          family: "chromium",
          browserName: sourceLabel,
          source,
          ...(opts?.userDataDir ? { userDataDir: opts.userDataDir } : {}),
          ...(resolvedProfile ? { profile: resolvedProfile } : {}),
          ...(opts?.cookieDbPath ? { cookieDbPath: dbPath } : {}),
          ...(opts?.safeStorageService ? { safeStorageService: opts.safeStorageService } : {}),
        }
      : null;
    return { cookies, source: cookies.length > 0 ? source : null, sourceMeta, warnings };
  } catch (err) {
    warnings.push(`${sourceLabel} extraction failed: ${err instanceof Error ? err.message : err}`);
    return { cookies: [], source: null, sourceMeta: null, warnings };
  }
}

// ---------------------------------------------------------------------------
// Firefox extraction
// ---------------------------------------------------------------------------

export function extractFromFirefox(
  domain: string,
  opts?: { profile?: string; profilesRoot?: string },
): ExtractionResult {
  const warnings: string[] = [];
  const dbPath = getFirefoxCookiesPath(opts?.profile, opts?.profilesRoot);
  const browserLabel = opts?.profilesRoot ? "Zen" : "Firefox";

  if (!dbPath) {
    warnings.push(`${browserLabel} cookies DB not found`);
    return { cookies: [], source: null, sourceMeta: null, warnings };
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

    const source = opts?.profile ? `${browserLabel} profile "${opts.profile}"` : `${browserLabel} default profile`;
    if (cookies.length === 0) {
      warnings.push(`No cookies for ${domain} found in ${source}`);
    }
    log("auth", `extracted ${cookies.length} cookies for ${domain} from ${source}`);
    const sourceMeta: BrowserAuthSourceMeta | null = cookies.length > 0
      ? {
          family: "firefox",
          browserName: browserLabel,
          source,
          ...(opts?.profile ? { profile: opts.profile } : {}),
        }
      : null;
    return { cookies, source: cookies.length > 0 ? source : null, sourceMeta, warnings };
  } catch (err) {
    warnings.push(`${browserLabel} extraction failed: ${err instanceof Error ? err.message : err}`);
    return { cookies: [], source: null, sourceMeta: null, warnings };
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

  // If caller provided an explicit Chromium-family source, try that first.
  if (opts?.chromium?.cookieDbPath || opts?.chromium?.userDataDir) {
    const chromium = extractFromChromium(domain, opts.chromium);
    return chromium;
  }

  const home = homedir();
  const chromiumBrowsers: ChromiumBrowserCandidate[] =
    platform() === "darwin"
      ? [
          { name: "Chrome", userDataDir: getChromeUserDataDir(), safeStorageService: "Chrome Safe Storage", bundleId: "com.google.chrome" },
          { name: "Arc", userDataDir: join(home, "Library", "Application Support", "Arc", "User Data"), safeStorageService: "Arc Safe Storage", bundleId: "company.thebrowser.Browser" },
          { name: "Dia", userDataDir: join(home, "Library", "Application Support", "Dia", "User Data"), safeStorageService: "Dia Safe Storage", bundleId: "company.thebrowser.dia" },
          { name: "Brave", userDataDir: join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"), safeStorageService: "Brave Safe Storage", bundleId: "com.brave.Browser" },
          { name: "Edge", userDataDir: join(home, "Library", "Application Support", "Microsoft Edge"), safeStorageService: "Microsoft Edge Safe Storage", bundleId: "com.microsoft.edgemac" },
          { name: "Vivaldi", userDataDir: join(home, "Library", "Application Support", "Vivaldi"), safeStorageService: "Vivaldi Safe Storage", bundleId: "com.vivaldi.Vivaldi" },
          { name: "Chromium", userDataDir: join(home, "Library", "Application Support", "Chromium"), safeStorageService: "Chromium Safe Storage", bundleId: "org.chromium.Chromium" },
        ]
      : platform() === "linux"
        ? [
            { name: "Chrome", userDataDir: getChromeUserDataDir(), safeStorageService: "Chrome Safe Storage" },
            { name: "Brave", userDataDir: join(home, ".config", "BraveSoftware", "Brave-Browser"), safeStorageService: "Brave Safe Storage" },
            { name: "Edge", userDataDir: join(home, ".config", "microsoft-edge"), safeStorageService: "Microsoft Edge Safe Storage" },
            { name: "Vivaldi", userDataDir: join(home, ".config", "vivaldi"), safeStorageService: "Vivaldi Safe Storage" },
            { name: "Chromium", userDataDir: join(home, ".config", "chromium"), safeStorageService: "Chromium Safe Storage" },
          ]
        : [];

  const preferredBundleId = getMacDefaultBrowserBundleId();
  const orderedChromiumBrowsers = prioritizeChromiumCandidates(chromiumBrowsers, preferredBundleId);

  const preferredChromium = preferredBundleId ? orderedChromiumBrowsers[0] : null;
  const accumulatedWarnings: string[] = [];
  if (preferredChromium?.bundleId === preferredBundleId && existsSync(preferredChromium.userDataDir)) {
    const preferredResult = extractFromChromium(domain, {
      userDataDir: preferredChromium.userDataDir,
      browserName: preferredChromium.name,
      safeStorageService: preferredChromium.safeStorageService,
    });
    if (preferredResult.cookies.length > 0) {
      return preferredResult;
    }
    accumulatedWarnings.push(...preferredResult.warnings);
  }

  // Try Firefox next (no decryption needed, more reliable when it actually has the session)
  const ff = extractFromFirefox(domain, { profile: opts?.firefoxProfile });
  if (ff.cookies.length > 0) {
    ff.warnings.push(...accumulatedWarnings);
    return ff;
  }

  const allWarnings = [...accumulatedWarnings, ...ff.warnings];
  for (const browser of orderedChromiumBrowsers) {
    if (browser.bundleId && browser.bundleId === preferredBundleId) continue;
    if (!existsSync(browser.userDataDir)) continue;
    const result = extractFromChromium(domain, {
      userDataDir: browser.userDataDir,
      browserName: browser.name,
      safeStorageService: browser.safeStorageService,
    });
    if (result.cookies.length > 0) {
      result.warnings.push(...allWarnings);
      return result;
    }
    allWarnings.push(...result.warnings);
  }

  // Also try Firefox-based alternatives (Zen)
  const zenPaths = platform() === "darwin"
    ? [join(home, "Library", "Application Support", "zen")]
    : [join(home, ".zen")];
  for (const zenRoot of zenPaths) {
    if (!existsSync(zenRoot)) continue;
    const zenResult = extractFromFirefox(domain, { profilesRoot: zenRoot });
    if (zenResult.cookies.length > 0) {
      zenResult.warnings.push(...allWarnings);
      return zenResult;
    }
    allWarnings.push(...zenResult.warnings);
  }

  return { cookies: [], source: null, sourceMeta: null, warnings: allWarnings };
}
