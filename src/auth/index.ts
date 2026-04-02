import * as kuri from "../kuri/client.js";
import { storeCredential, getCredential, deleteCredential } from "../vault/index.js";
import { nanoid } from "nanoid";
import { isDomainMatch, getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { getDefaultLoginConfig } from "../runtime/supervisor.js";

const LOGIN_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;
const MIN_WAIT_MS = 15_000;
const LOGIN_PATHS = /\/(login|signin|sign-in|sso|auth|oauth|uas\/login|checkpoint)/i;
const CLOUDFLARE_TEXT = /just a moment|attention required|verify you are human|cloudflare/i;

/**
 * Returns the persistent profile directory for a given domain.
 * Stored under ~/.unbrowse/profiles/<registrableDomain>.
 */
export function getProfilePath(domain: string): string {
  return path.join(os.homedir(), ".unbrowse", "profiles", getRegistrableDomain(domain));
}

export interface LoginResult {
  success: boolean;
  domain: string;
  cookies_stored: number;
  error?: string;
}

export interface BrowserAuthSourceMeta {
  family?: string;
  userDataDir?: string;
  cookieDbPath?: string;
}

export interface StoredAuthBundle {
  cookies: AuthCookie[];
  headers: Record<string, string>;
  source_keys: string[];
  source_meta?: BrowserAuthSourceMeta | null;
}

export type InteractiveLoginAssessment =
  | { status: "pending"; reason: string }
  | { status: "authenticated"; reason: string }
  | { status: "blocked"; reason: string };

export function assessInteractiveLoginState(input: {
  currentUrl: string;
  targetDomain: string;
  initialCookieCount: number;
  currentCookieCount: number;
  hasCloudflareChallenge?: boolean;
  pageText?: string;
}): InteractiveLoginAssessment {
  let parsed: URL;
  try {
    parsed = new URL(input.currentUrl);
  } catch {
    return { status: "pending", reason: "invalid_url" };
  }

  const currentDomain = parsed.hostname.toLowerCase();
  const targetNorm = input.targetDomain.toLowerCase();
  const isOnTarget = currentDomain === targetNorm || currentDomain.endsWith(`.${targetNorm}`);
  if (!isOnTarget) return { status: "pending", reason: "off_target_domain" };

  if (input.hasCloudflareChallenge) return { status: "blocked", reason: "cloudflare_challenge" };
  if (input.pageText && CLOUDFLARE_TEXT.test(input.pageText)) return { status: "blocked", reason: "cloudflare_text" };
  if (LOGIN_PATHS.test(parsed.pathname)) return { status: "pending", reason: "still_on_login_path" };

  if (input.currentCookieCount > input.initialCookieCount) {
    return { status: "authenticated", reason: "new_cookies_on_target" };
  }
  if (input.currentCookieCount > 0) {
    return { status: "authenticated", reason: "cookies_present_on_target" };
  }

  return { status: "pending", reason: "no_session_cookies" };
}

export function storedAuthNeedsBrowserRefresh(bundle: StoredAuthBundle | null | undefined): boolean {
  if (!bundle) return true;
  if (bundle.cookies.length === 0 && Object.keys(bundle.headers).length === 0) return true;
  const sourceMeta = bundle.source_meta;
  if (!sourceMeta) return true;
  if (sourceMeta.family === "chromium" && !sourceMeta.userDataDir && !sourceMeta.cookieDbPath) {
    return true;
  }
  return false;
}
/**
 * Open a visible browser for the user to complete login.
 * Uses Kuri to manage the browser tab, polls for login completion via cookies.
 *
 * Note: Kuri manages Chrome — for interactive login, the user's Chrome
 * needs to be visible. We navigate to the login URL and poll for cookie changes.
 */
export async function interactiveLogin(
  url: string,
  domain?: string,
): Promise<LoginResult> {
  const targetDomain = domain ?? new URL(url).hostname;
  const profileDir = getProfilePath(targetDomain);

  const isHeadless = process.env.HEADLESS === "true" || process.env.HEADLESS === "1";
  const loginConfig = getDefaultLoginConfig(isHeadless);
  log("auth", `interactiveLogin — url: ${url}, domain: ${targetDomain}, interactive: ${loginConfig.interactive}, timeout: ${loginConfig.timeout_ms}ms`);

  // Login requires a visible browser — disable headless for this flow
  const prevHeadless = process.env.HEADLESS;
  process.env.HEADLESS = "false";

  try {
    fs.mkdirSync(profileDir, { recursive: true });

    // Stop any existing headless Kuri so it restarts with HEADLESS=false
    try { await kuri.stop(); } catch { /* may not be running */ }

    // Start Kuri and get a tab
    await kuri.start();
    const tabId = await kuri.getDefaultTab();
    await kuri.networkEnable(tabId);

    // Navigate to login URL
    await kuri.navigate(tabId, url);

    const startTime = Date.now();

    // Snapshot initial cookies
    const initialCookies = await kuri.getCookies(tabId);
    const initialCookieCount = initialCookies.filter((c) => isDomainMatch(c.domain, targetDomain)).length;
    log("auth", `initial cookies for ${targetDomain}: ${initialCookieCount}`);

    // Wait for user to complete login — detect via cookie changes + URL change
    let loggedIn = false;
    let blockedReason: string | null = null;
    let lastLoggedUrl = "";
    const effectiveTimeout = loginConfig.interactive ? LOGIN_TIMEOUT_MS : loginConfig.timeout_ms;
    while (Date.now() - startTime < effectiveTimeout) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const elapsed = Date.now() - startTime;

      try {
        const currentUrl = await kuri.getCurrentUrl(tabId);
        if (currentUrl !== lastLoggedUrl) {
          log("auth", `navigated to: ${currentUrl}`);
          lastLoggedUrl = currentUrl;
        }

        if (elapsed < MIN_WAIT_MS) continue;

        const currentCookies = await kuri.getCookies(tabId);
        const currentCookieCount = currentCookies.filter((c) => isDomainMatch(c.domain, targetDomain)).length;
        const hasCloudflareChallenge = await kuri.hasCloudflareChallenge(tabId).catch(() => false);
        const pageText = hasCloudflareChallenge ? await kuri.getText(tabId).catch(() => "") : "";
        const assessment = assessInteractiveLoginState({
          currentUrl,
          targetDomain,
          initialCookieCount,
          currentCookieCount,
          hasCloudflareChallenge,
          pageText,
        });

        if (assessment.status === "authenticated") {
          loggedIn = true;
          log("auth", `login complete — ${currentUrl} (cookies: ${initialCookieCount} → ${currentCookieCount}; ${assessment.reason})`);
          break;
        }

        if (assessment.status === "blocked") {
          blockedReason = assessment.reason;
          log("auth", `login blocked — ${currentUrl} (${assessment.reason})`);
        }
      } catch { /* page navigating */ }
    }

    if (!loggedIn) {
      log("auth", `login wait ended after ${Math.round((Date.now() - startTime) / 1000)}s — fallback: ${loginConfig.fallback_strategy}`);
      if (loginConfig.fallback_strategy === "fail") {
        const error = blockedReason
          ? `Login blocked (${blockedReason})`
          : "Login timed out (fallback: fail)";
        return { success: false, domain: targetDomain, cookies_stored: 0, error };
      }
      if (loginConfig.fallback_strategy === "skip") {
        log("auth", `skipping cookie capture per fallback_strategy`);
        return { success: false, domain: targetDomain, cookies_stored: 0, error: "Login skipped (headless)" };
      }
      // fallback_strategy === "prompt" — continue to capture cookies anyway
    }

    // Extract and store cookies
    const cookies = await kuri.getCookies(tabId);
    const domainCookies = cookies.filter((c) => isDomainMatch(c.domain, targetDomain));

    if (domainCookies.length === 0) {
      return { success: false, domain: targetDomain, cookies_stored: 0, error: "No cookies captured for domain" };
    }

    const storableCookies = domainCookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path,
      secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, expires: c.expires,
    }));

    const vaultKey = `auth:${getRegistrableDomain(targetDomain)}`;
    await storeCredential(vaultKey, JSON.stringify({ cookies: storableCookies }));
    log("auth", `stored ${storableCookies.length} cookies under ${vaultKey}`);

    // Also save as Kuri auth profile so browse commands (go/snap/click) have auth
    try {
      await kuri.authProfileSave(tabId, targetDomain.replace(/^www\./, ""));
      log("auth", `saved Kuri auth profile for ${targetDomain}`);
    } catch { /* non-fatal — Kuri auth profile save is best-effort */ }

    return { success: true, domain: targetDomain, cookies_stored: storableCookies.length };
  } finally {
    // Restore headless setting so subsequent captures run headless
    if (prevHeadless !== undefined) process.env.HEADLESS = prevHeadless;
    else delete process.env.HEADLESS;
  }
}

/**
 * Extract cookies directly from Chrome/Firefox SQLite databases.
 * No browser launch needed, Chrome can stay open.
 */
export async function extractBrowserAuth(
  domain: string,
  opts?: { chromeProfile?: string; firefoxProfile?: string }
): Promise<LoginResult> {
  const { extractBrowserCookies } = await import("./browser-cookies.js");

  const result = extractBrowserCookies(domain, opts);

  if (result.cookies.length === 0) {
    return {
      success: false,
      domain,
      cookies_stored: 0,
      error: result.warnings.join("; ") || "No cookies found in any browser",
    };
  }

  const storableCookies = result.cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expires: c.expires,
  }));

  const vaultKey = `auth:${getRegistrableDomain(domain)}`;
  await storeCredential(
    vaultKey,
    JSON.stringify({ cookies: storableCookies })
  );

  log("auth", `stored ${storableCookies.length} cookies for ${domain} (key: ${vaultKey}) from ${result.source}`);
  return { success: true, domain, cookies_stored: storableCookies.length };
}

type AuthCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
};

/** Filter out expired cookies. Session cookies (expires <= 0) are kept. */
function filterExpired(cookies: AuthCookie[]): AuthCookie[] {
  const now = Math.floor(Date.now() / 1000);
  return cookies.filter((c) => {
    if (c.expires == null || c.expires <= 0) return true;
    return c.expires > now;
  });
}

/**
 * Retrieve stored auth cookies for a domain from the vault.
 * Filters out expired cookies automatically.
 */
export async function getStoredAuth(
  domain: string
): Promise<AuthCookie[] | null> {
  const bundle = await getStoredAuthBundle(domain);
  return bundle?.cookies?.length ? bundle.cookies : null;
}

/**
 * Retrieve the stored auth bundle for a domain from the vault.
 * Preserves headers/source metadata while filtering expired cookies.
 */
export async function getStoredAuthBundle(
  domain: string
): Promise<StoredAuthBundle | null> {
  const regDomain = getRegistrableDomain(domain);
  const keysToTry = [`auth:${regDomain}`];
  if (domain !== regDomain) keysToTry.push(`auth:${domain}`);

  for (const key of keysToTry) {
    const stored = await getCredential(key);
    if (!stored) continue;
    try {
      const parsed = JSON.parse(stored) as Partial<StoredAuthBundle> & { cookies?: AuthCookie[] };
      const cookies = parsed.cookies ?? [];
      const valid = filterExpired(cookies);
      if (cookies.length > 0 && valid.length === 0 && Object.keys(parsed.headers ?? {}).length === 0) {
        log("auth", `all ${cookies.length} cookies for ${domain} (key: ${key}) are expired — deleting`);
        await deleteCredential(key);
        continue;
      }
      if (valid.length < cookies.length) {
        log("auth", `filtered ${cookies.length - valid.length} expired cookies for ${domain}`);
      }
      return {
        cookies: valid,
        headers: parsed.headers ?? {},
        source_keys: parsed.source_keys ?? [],
        source_meta: parsed.source_meta ?? null,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Bird-style unified cookie resolution with auto-extract fallback.
 *
 * Fallback chain:
 *   1. Vault cookies (fast path)
 *   2. Auto-extract from Chrome/Firefox SQLite (bird pattern — always fresh)
 */
export async function getAuthCookies(
  domain: string
): Promise<AuthCookie[] | null> {
  const vaultCookies = await getStoredAuth(domain);
  if (vaultCookies && vaultCookies.length > 0) return vaultCookies;

  log("auth", `no vault cookies for ${domain} — auto-extracting from browser`);
  try {
    const result = await extractBrowserAuth(domain);
    if (result.success && result.cookies_stored > 0) {
      return getStoredAuth(domain);
    }
  } catch (err) {
    log("auth", `browser auto-extract failed for ${domain}: ${err instanceof Error ? err.message : err}`);
  }

  return null;
}

/**
 * Refresh credentials from browser after a 401/403.
 * Returns true if fresh cookies were stored.
 */
export async function refreshAuthFromBrowser(domain: string): Promise<boolean> {
  log("auth", `401/403 received — attempting to refresh auth for ${domain} from browser`);
  try {
    const result = await extractBrowserAuth(domain);
    if (result.success && result.cookies_stored > 0) {
      log("auth", `refreshed ${result.cookies_stored} cookies for ${domain} from browser`);
      return true;
    }
  } catch (err) {
    log("auth", `browser refresh failed for ${domain}: ${err instanceof Error ? err.message : err}`);
  }
  return false;
}
