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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import { log } from "../logger.js";
import { getRegistrableDomain, isDomainMatch } from "../domain.js";
import { getUnbrowseHome } from "../runtime/paths.js";
import {
  CHROME_PROFILE_TARGET,
  FIREFOX_PROFILE_TARGET,
  existingBrowserProfileRoots,
  listBrowserProfileArtifacts,
  resolveBrowserProfileRoot,
} from "./browser-profile-roots.js";

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
  // Native path first, then Flatpak/Snap — see browser-profile-roots.ts.
  return (
    resolveBrowserProfileRoot(CHROME_PROFILE_TARGET) ??
    join(homedir(), ".config", "google-chrome")
  );
}

/** Cookie-jar layouts a Chromium profile directory can use, in probe order. */
const CHROMIUM_JAR_NAMES = [join("Network", "Cookies"), "Cookies"] as const;

export function resolveChromiumCookiesPath(opts?: ChromiumCookieSourceOptions): string | null {
  return listChromiumCookieJars(opts)[0] ?? null;
}

/**
 * Every Chromium cookie jar this option set can reach, best-first.
 *
 * With an explicit `cookieDbPath` / `profile` / `userDataDir` the caller has
 * already chosen, and only that choice is probed. With none of them, profiles
 * are DISCOVERED rather than assumed: hard-coding `Default` reads a logged-out
 * jar whenever the signed-in session lives on `Profile 1`/`Profile 3`, and no
 * list of profile names is ever complete.
 */
function listChromiumCookieJars(opts?: ChromiumCookieSourceOptions): string[] {
  if (opts?.cookieDbPath) {
    return [opts.cookieDbPath.replace(/^~\//, homedir() + "/")];
  }

  // An explicit profile, or a caller-supplied user-data dir: probe exactly that
  // directory (this is also the per-root path `scanAllBrowserSessions` drives).
  if (opts?.profile || opts?.userDataDir) {
    const profileDir = opts?.profile;
    const userDataDir = (opts?.userDataDir || getChromeUserDataDir()).replace(
      /^~\//,
      homedir() + "/",
    );
    const dirs = profileDir ? [join(userDataDir, profileDir)] : [];
    if (!profileDir) {
      dirs.push(userDataDir);
      for (const entry of safeSubdirs(userDataDir)) dirs.push(join(userDataDir, entry));
    }
    const found = dirs
      .flatMap((dir) => CHROMIUM_JAR_NAMES.map((name) => join(dir, name)))
      .filter((candidate) => existsSync(candidate));
    if (found.length > 0) return found;
    // Nothing on disk: keep naming the conventional location so the warning
    // points somewhere a user recognises.
    return [join(userDataDir, profileDir ?? "Default", "Cookies")];
  }

  const discovered = listBrowserProfileArtifacts(CHROME_PROFILE_TARGET, CHROMIUM_JAR_NAMES).map(
    (a) => a.path,
  );
  return discovered.length > 0
    ? discovered
    : [join(getChromeUserDataDir(), "Default", "Cookies")];
}

/** Directory entries under `dir`, or none when it is unreadable. */
function safeSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function getFirefoxProfilesRoot(): string | null {
  return resolveBrowserProfileRoot(FIREFOX_PROFILE_TARGET);
}

/**
 * Every Firefox cookie jar on this machine, best-first.
 *
 * A machine can hold a native AND a Flatpak/Snap Firefox, each with several
 * profiles, and the logged-in one is whichever the user actually browses with —
 * its directory is named by them (`ij8zicoh.stream`), not `default-release`.
 * Matching that name read the wrong jar and reported a logged-out session on a
 * logged-in machine, so every jar is a candidate and the caller picks by
 * evidence (see `extractFromFirefox`).
 */
function listFirefoxCookieJars(profile?: string): string[] {
  if (profile) {
    const out: string[] = [];
    for (const root of existingBrowserProfileRoots(FIREFOX_PROFILE_TARGET)) {
      const candidate = join(root, profile, "cookies.sqlite");
      if (existsSync(candidate)) out.push(candidate);
    }
    return out;
  }
  return listBrowserProfileArtifacts(FIREFOX_PROFILE_TARGET, "cookies.sqlite").map((a) => a.path);
}

function getFirefoxCookiesPath(profile?: string): string | null {
  return listFirefoxCookieJars(profile)[0] ?? null;
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

/**
 * Read one Chromium jar. Separated from profile selection so every candidate is
 * read the same way and `extractFromChromium` can compare them.
 */
function readChromiumJar(
  domain: string,
  dbPath: string,
  opts?: ChromiumCookieSourceOptions,
): BrowserCookie[] {
  return withTempCopy(dbPath, (tempDb) => {
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
}

/**
 * Cookies for `domain` from the Chromium-family profile that actually holds the
 * session — scored with the same `sessionQuality` used everywhere else, so a
 * user signed in on `Profile 2` is found without `Profile 2` appearing in any
 * list. An explicit `profile`/`cookieDbPath` still pins exactly one jar.
 */
export function extractFromChromium(
  domain: string,
  opts?: ChromiumCookieSourceOptions,
): ExtractionResult {
  const warnings: string[] = [];
  const jars = listChromiumCookieJars(opts).filter((p) => existsSync(p));
  const sourceLabel = opts?.browserName || "Chromium";

  if (jars.length === 0) {
    const attempted = resolveChromiumCookiesPath(opts);
    warnings.push(`${sourceLabel} cookies DB not found${attempted ? ` at ${attempted}` : ""}`);
    return { cookies: [], source: null, warnings };
  }

  let best: { cookies: BrowserCookie[]; quality: number; dbPath: string } | null = null;
  for (const dbPath of jars) {
    let cookies: BrowserCookie[];
    try {
      cookies = readChromiumJar(domain, dbPath, opts);
    } catch (err) {
      warnings.push(
        `${sourceLabel} extraction failed for ${profileLabel(dbPath)}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    if (cookies.length === 0) continue;
    const { quality } = sessionQuality(cookies);
    if (!best || quality > best.quality) best = { cookies, quality, dbPath };
  }

  if (!best) {
    const scope = opts?.cookieDbPath
      ? `${sourceLabel} cookie DB "${jars[0]}"`
      : `${sourceLabel} (${jars.length} profile(s))`;
    warnings.push(`No cookies for ${domain} found in ${scope}`);
    return { cookies: [], source: null, warnings };
  }

  const source = opts?.cookieDbPath
    ? `${sourceLabel} cookie DB "${best.dbPath}"`
    : `${sourceLabel} profile "${profileLabel(best.dbPath)}"`;
  log("auth", `extracted ${best.cookies.length} cookies for ${domain} from ${source}`);
  return { cookies: best.cookies, source, warnings };
}

// ---------------------------------------------------------------------------
// Firefox extraction
// ---------------------------------------------------------------------------

/** The profile directory a jar belongs to, for user-facing source strings. */
function profileLabel(dbPath: string): string {
  const parts = dbPath.split("/").filter((p) => p.length > 0);
  // <root>/<profile>/cookies.sqlite, or <root>/<profile>/Network/Cookies
  const idx = parts.length - (parts[parts.length - 2] === "Network" ? 3 : 2);
  return parts[idx] ?? dbPath;
}

/**
 * Read one Firefox jar. Separated from profile selection so every candidate is
 * read the same way and `extractFromFirefox` can compare them.
 */
function readFirefoxJar(domain: string, dbPath: string): BrowserCookie[] {
  return withTempCopy(dbPath, (tempDb) => {
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
}

/**
 * Cookies for `domain` from the Firefox profile that actually holds the
 * session. Every jar on the machine is read and scored with `sessionQuality` —
 * the same auth-shape scorer that already ranks jars ACROSS browsers — so the
 * winner is the one carrying auth-shaped, session-scoped cookies rather than
 * the one whose directory name happened to match a convention.
 */
export function extractFromFirefox(
  domain: string,
  opts?: { profile?: string },
): ExtractionResult {
  const warnings: string[] = [];
  const jars = listFirefoxCookieJars(opts?.profile);

  if (jars.length === 0) {
    warnings.push("Firefox cookies DB not found");
    return { cookies: [], source: null, warnings };
  }

  let best: { cookies: BrowserCookie[]; quality: number; dbPath: string } | null = null;
  for (const dbPath of jars) {
    let cookies: BrowserCookie[];
    try {
      cookies = readFirefoxJar(domain, dbPath);
    } catch (err) {
      // One unreadable jar (locked, corrupt, permissions) must not hide the
      // profile next in line that does hold the session.
      warnings.push(
        `Firefox extraction failed for ${profileLabel(dbPath)}: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }
    if (cookies.length === 0) continue;
    const { quality } = sessionQuality(cookies);
    if (!best || quality > best.quality) best = { cookies, quality, dbPath };
  }

  if (!best) {
    const scope = opts?.profile ? `Firefox profile "${opts.profile}"` : `Firefox (${jars.length} profile(s))`;
    warnings.push(`No cookies for ${domain} found in ${scope}`);
    return { cookies: [], source: null, warnings };
  }

  const source = `Firefox profile "${profileLabel(best.dbPath)}"`;
  log("auth", `extracted ${best.cookies.length} cookies for ${domain} from ${source}`);
  return { cookies: best.cookies, source, warnings };
}

// ---------------------------------------------------------------------------
// Unified extraction — tries Firefox first, then Chrome (bird's priority)
// ---------------------------------------------------------------------------

export function browserCookieOptionsFromEnv(
  opts?: ExtractBrowserCookiesOptions,
  env: Record<string, string | undefined> = process.env,
): ExtractBrowserCookiesOptions | undefined {
  const userDataDir = env.UNBROWSE_CHROME_USER_DATA_DIR?.trim();
  const cookieDbPath = env.UNBROWSE_COOKIE_DB_PATH?.trim();
  const profile = env.UNBROWSE_CHROME_PROFILE?.trim();
  if (!userDataDir && !cookieDbPath && !profile) return opts;
  return {
    ...opts,
    browser: opts?.browser ?? "chromium",
    chromium: {
      ...opts?.chromium,
      ...(userDataDir ? { userDataDir } : {}),
      ...(cookieDbPath ? { cookieDbPath } : {}),
      ...(profile ? { profile } : {}),
    },
  };
}

export function extractBrowserCookies(
  domain: string,
  opts?: ExtractBrowserCookiesOptions,
): ExtractionResult {
  const result = _extractBrowserCookiesInner(domain, browserCookieOptionsFromEnv(opts));
  writeAuthExtractTrace(domain, result);
  return result;
}

// Diagnostics are OFF unless asked for, matching the UNBROWSE_TRACE convention in
// logger.ts: collection a user never opted into is the defect, not the file format.
const AUTH_TRACE_ENABLED = (() => {
  const v = process.env.UNBROWSE_TRACE_AUTH;
  return v != null && v !== "" && v !== "0";
})();

// An append-only diagnostic that grows forever is its own kind of leak. Truncate
// rather than rotate — a stale extraction count has no diagnostic value at all.
const AUTH_TRACE_MAX_BYTES = 1024 * 1024;

/**
 * Record that an extraction happened, never what it extracted.
 *
 * This trace answers exactly one question — "auth degraded to logged-out, did we
 * read any cookies and from where?" — and a count plus a source answers it. The
 * previous version also wrote `{n, v, d}` per cookie, i.e. every session
 * credential in the jar, in cleartext, to a world-readable append-only file that
 * nothing in this repo ever reads and nothing ever rotates. It was silent
 * because it was wrapped in `try {} catch {}`, and it looked harmless because
 * extraction had been returning zero cookies on Linux since the profile-discovery
 * bug — fixing that bug is what would have armed this one.
 *
 * Names are withheld along with values: `session_id @ bank.example` is still a
 * credential's fingerprint, and a name plus a domain is still browsing history.
 * Same boundary `safeBindingNames` draws in telemetry.ts — values never leave.
 */
function writeAuthExtractTrace(domain: string, result: ExtractionResult): void {
  if (!AUTH_TRACE_ENABLED) return;
  try {
    const traceDir = join(getUnbrowseHome(), "traces");
    if (!existsSync(traceDir)) mkdirSync(traceDir, { recursive: true, mode: 0o700 });
    const file = join(traceDir, "auth-extract.jsonl");
    if (existsSync(file) && statSync(file).size > AUTH_TRACE_MAX_BYTES) rmSync(file);
    const entry = JSON.stringify({
      d: domain,
      n: result.cookies.length,
      src: result.source,
      t: Date.now(),
    }) + "\n";
    writeFileSync(file, entry, { flag: "a", mode: 0o600 });
  } catch {}
}

function _extractBrowserCookiesInner(
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

  // Auto path: pick the BEST jar for this host across every installed browser
  // (session-cookie quality), not "Firefox first if any cookie exists". That
  // old order silently preferred a weak Firefox jar over a richer Chrome/Brave
  // session (and surprised operators when act go injected the wrong account).
  // Explicit browser= / profile= still short-circuit above.
  if (opts?.chromium?.cookieDbPath || opts?.chromium?.userDataDir || opts?.chromium?.profile) {
    return extractFromChromium(domain, opts.chromium);
  }

  const best = findBestBrowserSession(domain);
  if (best && best.cookies.length > 0) {
    return {
      cookies: best.cookies,
      source: best.source,
      warnings: [
        `auto: chose ${best.browser} for ${domain} (sessionCookies=${best.sessionCookies}, total=${best.cookies.length})`,
      ],
    };
  }

  // Nothing found — surface Firefox/Chrome miss warnings for diagnostics.
  const ff = extractFromFirefox(domain, { profile: opts?.firefoxProfile });
  if (ff.cookies.length > 0) return ff;
  const chrome = extractFromChrome(domain, { profile: opts?.chromeProfile });
  chrome.warnings.push(...ff.warnings);
  return chrome;
}

// ---------------------------------------------------------------------------
// Multi-browser session scanner — find best logged-in session across all browsers
// ---------------------------------------------------------------------------

export interface BrowserSessionResult {
  browser: string;
  cookies: BrowserCookie[];
  sessionCookies: number; // httpOnly + secure = likely auth
  /** Quality score used to pick the jar (session + auth-name lift + total). */
  quality: number;
  source: string | null;
}

/**
 * Cookie names that look like session/auth. THE definition — every judgement of
 * "is this jar logged in?" reads it (jar ranking below, the auth inventory's
 * score lift, the capture pipeline's decision to inject vault cookies). A second
 * copy drifts, and a heuristic that disagrees with the extractor is how a
 * logged-in machine gets treated as anonymous.
 */
export const AUTH_COOKIE_NAME_RE = /session|sess|auth|token|user|uid|login|jwt|sid|csrf|xsrf/i;

/** Does this cookie name look like it carries a session? */
export function looksLikeAuthCookieName(name: string): boolean {
  return AUTH_COOKIE_NAME_RE.test(name);
}

/**
 * Does this cookie set represent a REAL logged-in session, as opposed to the
 * guest/analytics jar every visitor accumulates?
 *
 * The distinction cannot be made from the page URL: sites that serve guests a
 * full page (x.com, reddit) never redirect to `/login`, so "we are not on a
 * login path" says nothing. An authenticated jar carries a cookie that is BOTH
 * auth-named and transport-protected (httpOnly or secure) — `auth_token` — while
 * a guest jar carries `guest_id` / `personalization_id` and no such cookie.
 */
export function hasAuthenticatedSession(
  cookies: ReadonlyArray<{ name: string; httpOnly?: boolean; secure?: boolean }>,
): boolean {
  return cookies.some((c) => looksLikeAuthCookieName(c.name) && (c.httpOnly === true || c.secure === true));
}

function sessionQuality(cookies: BrowserCookie[]): { sessionCookies: number; quality: number } {
  let sessionCookies = 0;
  let authNamed = 0;
  for (const c of cookies) {
    if (c.httpOnly || c.secure) sessionCookies += 1;
    if (AUTH_COOKIE_NAME_RE.test(c.name)) authNamed += 1;
  }
  // Prefer jars with auth-shaped + session cookies; total count breaks ties.
  const quality = sessionCookies * 10 + authNamed * 5 + cookies.length;
  return { sessionCookies, quality };
}

interface ChromiumBrowserDescriptor {
  name: string;
  macPath: string;
  /** Leaf under `~/.config` on Linux. Absent = the browser has no Linux build. */
  linuxUserData?: string;
  winPath?: string;
}

const CHROMIUM_BROWSERS: ChromiumBrowserDescriptor[] = [
  { name: "Chrome", macPath: "Google/Chrome", linuxUserData: "google-chrome" },
  { name: "Arc", macPath: "Arc/User Data" },
  { name: "Brave", macPath: "BraveSoftware/Brave-Browser", linuxUserData: "BraveSoftware/Brave-Browser" },
  { name: "Edge", macPath: "Microsoft Edge", linuxUserData: "microsoft-edge" },
  { name: "Vivaldi", macPath: "Vivaldi", linuxUserData: "vivaldi" },
  { name: "Opera", macPath: "com.operasoftware.Opera", linuxUserData: "opera" },
  { name: "Dia", macPath: "Dia/User Data" },
  { name: "Chromium", macPath: "Chromium", linuxUserData: "chromium" },
];

/**
 * The user-data directory for one Chromium-family browser, through the shared
 * resolver: native, then Flatpak (both layouts), then Snap.
 *
 * The lowercased `macPath` is kept as a compatibility alias behind the
 * canonical Linux leaf — it is where this scan used to look, so a machine that
 * resolved under the old expression still resolves to the same directory.
 */
function chromiumUserDataDir(browser: ChromiumBrowserDescriptor): string | null {
  const linuxAliases = browser.linuxUserData
    ? [browser.linuxUserData, browser.macPath.toLowerCase()]
    : [browser.macPath.toLowerCase()];
  return resolveBrowserProfileRoot({
    family: "chromium",
    macPath: browser.macPath,
    winPath: browser.winPath,
    linuxUserData: linuxAliases,
  });
}

export function scanAllBrowserSessions(domain: string): BrowserSessionResult[] {
  const results: BrowserSessionResult[] = [];

  for (const browser of CHROMIUM_BROWSERS) {
    // Every existing root (native + Flatpak + user-configured memory paths).
    const linuxAliases = browser.linuxUserData
      ? [browser.linuxUserData, browser.macPath.toLowerCase()]
      : [browser.macPath.toLowerCase()];
    const roots = existingBrowserProfileRoots({
      family: "chromium",
      macPath: browser.macPath,
      winPath: browser.winPath,
      linuxUserData: linuxAliases,
    });
    // Also the single-root resolver for parity with older installs.
    const primary = chromiumUserDataDir(browser);
    const dirs = [...new Set([...(primary ? [primary] : []), ...roots])].filter(
      (d) => d && existsSync(d),
    );

    for (const userDataDir of dirs) {
      try {
        const result = extractFromChromium(domain, {
          userDataDir,
          browserName: browser.name,
        });
        if (result.cookies.length > 0) {
          const { sessionCookies, quality } = sessionQuality(result.cookies);
          results.push({
            browser: browser.name,
            cookies: result.cookies,
            sessionCookies,
            quality,
            source: result.source,
          });
        }
      } catch { /* skip browsers that fail */ }
    }
  }

  // Also try Firefox
  try {
    const ff = extractFromFirefox(domain);
    if (ff.cookies.length > 0) {
      const { sessionCookies, quality } = sessionQuality(ff.cookies);
      results.push({
        browser: "Firefox",
        cookies: ff.cookies,
        sessionCookies,
        quality,
        source: ff.source,
      });
    }
  } catch { /* skip */ }

  // Best jar for this host: quality (auth-shaped + session), not install order.
  results.sort((a, b) => {
    if (b.quality !== a.quality) return b.quality - a.quality;
    if (b.sessionCookies !== a.sessionCookies) return b.sessionCookies - a.sessionCookies;
    return a.browser.localeCompare(b.browser);
  });
  return results;
}

export function findBestBrowserSession(domain: string): BrowserSessionResult | null {
  const sessions = scanAllBrowserSessions(domain);
  if (sessions.length === 0) return null;
  // Honor durable prefer from ~/.unbrowse/browser-paths.json when that browser
  // has any cookies for this host (even if quality is slightly lower).
  try {
    // Dynamic import-style require kept for optional config (no hard fail).
    const mod = require("./browser-path-config.js") as typeof import("./browser-path-config.js");
    const prefer = mod.preferredBrowserName();
    if (prefer) {
      const key = prefer.toLowerCase();
      const match = sessions.find((s) => {
        const bn = s.browser.toLowerCase();
        return bn === key
          || (key === "chromium" && bn === "chromium")
          || (key === "chrome" && bn === "chrome")
          || (key === "ff" && bn === "firefox");
      });
      if (match) return match;
      const entry = mod.loadBrowserPathConfig().browsers[key];
      if (entry?.userDataDir) {
        const byPath = sessions.find((s) => s.source && s.source.includes(entry.userDataDir));
        if (byPath) return byPath;
      }
    }
  } catch {
    /* no config */
  }
  return sessions[0] ?? null;
}

// ---------------------------------------------------------------------------
// Domain-summary scanner — list distinct domains the user has cookies for,
// without copying any cookie values. Used by the MCP resource layer.
// ---------------------------------------------------------------------------

export interface CookieDomainSummary {
  domain: string;
  browsers: string[];
  session_cookie_count: number;
  total_cookie_count: number;
  newest_cookie_at: string | null;
}

interface CookieDomainScanReport {
  domains: CookieDomainSummary[];
  browsers_scanned: string[];
  browsers_skipped: string[];
}

function chromiumCookiesPathForUserDataDir(userDataDir: string): string | null {
  const candidates = [
    join(userDataDir, "Default", "Cookies"),
    join(userDataDir, "Default", "Network", "Cookies"),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function scanChromiumDomainSummary(
  userDataDir: string,
  browserName: string,
): Array<{ host: string; total: number; session: number; newest: number | null }> | null {
  const dbPath = chromiumCookiesPathForUserDataDir(userDataDir);
  if (!dbPath) return null;
  try {
    return withTempCopy(dbPath, (temp) => {
      // creation_utc is microseconds since Jan 1 1601; convert to ms-since-epoch
      // at the read site. is_httponly+is_secure are the "session cookie" markers
      // we use elsewhere in this module.
      const sql =
        "SELECT host_key, COUNT(*), " +
        "SUM(CASE WHEN is_httponly=1 OR is_secure=1 THEN 1 ELSE 0 END), " +
        "MAX(creation_utc) " +
        "FROM cookies GROUP BY host_key";
      const raw = sqliteQuery(temp, sql);
      const rows = raw.split("\n").filter((l) => l.length > 0);
      const out: Array<{ host: string; total: number; session: number; newest: number | null }> = [];
      for (const line of rows) {
        const parts = line.split("|");
        if (parts.length < 4) continue;
        const host = parts[0]!;
        const total = Number.parseInt(parts[1] ?? "0", 10);
        const session = Number.parseInt(parts[2] ?? "0", 10);
        const creationMicros = Number.parseInt(parts[3] ?? "0", 10);
        // Chrome creation_utc: microseconds since 1601-01-01 UTC.
        // Convert to ms-since-epoch: (creation_utc - 11644473600000000) / 1000
        const newest = creationMicros > 0
          ? Math.round((creationMicros - 11644473600000000) / 1000)
          : null;
        out.push({ host, total, session, newest });
      }
      return out;
    });
  } catch {
    return null;
  }
}

function scanFirefoxDomainSummary(): Array<{ host: string; total: number; session: number; newest: number | null }> | null {
  // `getFirefoxCookiesPath` already walks every existing root (native first)
  // and returns a cookies.sqlite PATH. The previous version fed that path back
  // in as if it were a profile NAME, so the join never resolved and Firefox
  // silently contributed nothing to the domain scan on every platform.
  const cookiesPath = getFirefoxCookiesPath();
  if (!cookiesPath || !existsSync(cookiesPath)) return null;
  try {
    return withTempCopy(cookiesPath, (temp) => {
      // Firefox cookies.sqlite: lastAccessed is microseconds-since-epoch.
      // isHttpOnly + isSecure mark session cookies.
      const sql =
        "SELECT host, COUNT(*), " +
        "SUM(CASE WHEN isHttpOnly=1 OR isSecure=1 THEN 1 ELSE 0 END), " +
        "MAX(lastAccessed) " +
        "FROM moz_cookies GROUP BY host";
      const raw = sqliteQuery(temp, sql);
      const rows = raw.split("\n").filter((l) => l.length > 0);
      const out: Array<{ host: string; total: number; session: number; newest: number | null }> = [];
      for (const line of rows) {
        const parts = line.split("|");
        if (parts.length < 4) continue;
        const host = parts[0]!;
        const total = Number.parseInt(parts[1] ?? "0", 10);
        const session = Number.parseInt(parts[2] ?? "0", 10);
        const lastAccessMicros = Number.parseInt(parts[3] ?? "0", 10);
        const newest = lastAccessMicros > 0 ? Math.round(lastAccessMicros / 1000) : null;
        out.push({ host, total, session, newest });
      }
      return out;
    });
  } catch {
    return null;
  }
}

/**
 * Enumerate distinct domains the user has cookies for across all installed
 * Chromium-family browsers + Firefox. Returns metadata only — domain name,
 * cookie counts, newest cookie timestamp. Never returns cookie values.
 *
 * Intended for MCP resource exposure so the calling agent knows BEFORE
 * resolve/go whether the user has a cookied session for the target site.
 *
 * Domains are normalized by stripping a single leading "." (Chromium stores
 * `.github.com` and Firefox stores `github.com`; we surface the bare host
 * since that's what eTLD+1 matching expects).
 */
export function listCookieDomains(): CookieDomainScanReport {
  const browsersScanned: string[] = [];
  const browsersSkipped: string[] = [];
  // Aggregate {host -> {browsers:Set, total, session, newest}}
  const agg = new Map<string, { browsers: Set<string>; total: number; session: number; newest: number | null }>();

  for (const browser of CHROMIUM_BROWSERS) {
    const userDataDir = chromiumUserDataDir(browser);

    if (!userDataDir || !existsSync(userDataDir)) {
      browsersSkipped.push(`${browser.name} (not installed)`);
      continue;
    }
    const rows = scanChromiumDomainSummary(userDataDir, browser.name);
    if (rows == null) {
      browsersSkipped.push(`${browser.name} (cookies db unreadable)`);
      continue;
    }
    browsersScanned.push(browser.name);
    for (const row of rows) {
      const host = row.host.startsWith(".") ? row.host.slice(1) : row.host;
      let entry = agg.get(host);
      if (!entry) {
        entry = { browsers: new Set(), total: 0, session: 0, newest: null };
        agg.set(host, entry);
      }
      entry.browsers.add(browser.name);
      entry.total += row.total;
      entry.session += row.session;
      if (row.newest != null && (entry.newest == null || row.newest > entry.newest)) {
        entry.newest = row.newest;
      }
    }
  }

  // Firefox
  const ff = scanFirefoxDomainSummary();
  if (ff == null) {
    browsersSkipped.push("Firefox (not installed or unreadable)");
  } else {
    browsersScanned.push("Firefox");
    for (const row of ff) {
      const host = row.host.startsWith(".") ? row.host.slice(1) : row.host;
      let entry = agg.get(host);
      if (!entry) {
        entry = { browsers: new Set(), total: 0, session: 0, newest: null };
        agg.set(host, entry);
      }
      entry.browsers.add("Firefox");
      entry.total += row.total;
      entry.session += row.session;
      if (row.newest != null && (entry.newest == null || row.newest > entry.newest)) {
        entry.newest = row.newest;
      }
    }
  }

  const domains: CookieDomainSummary[] = [];
  for (const [domain, entry] of agg.entries()) {
    if (!domain) continue;
    domains.push({
      domain,
      browsers: [...entry.browsers],
      session_cookie_count: entry.session,
      total_cookie_count: entry.total,
      newest_cookie_at: entry.newest != null ? new Date(entry.newest).toISOString() : null,
    });
  }
  // Most-authenticated first
  domains.sort((a, b) => b.session_cookie_count - a.session_cookie_count);

  return { domains, browsers_scanned: browsersScanned, browsers_skipped: browsersSkipped };
}
