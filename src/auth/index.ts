import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";
import { storeCredential, getCredential, deleteCredential } from "../vault/index.js";
import { nanoid } from "nanoid";
import { isDomainMatch, getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const LOGIN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * Returns the persistent profile directory for a given domain.
 * Stored under ~/.unbrowse/profiles/<registrableDomain>.
 * Exporting so capture/execute can also launch with the profile if needed.
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

/**
 * Open a visible browser for the user to complete login.
 * Waits up to 120s for navigation back to the target domain, then captures cookies.
 * Uses an isolated persistent profile per domain.
 */
export async function interactiveLogin(
  url: string,
  domain?: string,
): Promise<LoginResult> {
  const targetDomain = domain ?? new URL(url).hostname;
  const profileDir = getProfilePath(targetDomain);

  const browser = new BrowserManager();
  log("auth", `interactiveLogin — url: ${url}, domain: ${targetDomain}`);

  try {
    fs.mkdirSync(profileDir, { recursive: true });
    await browser.launch({
      action: "launch",
      id: nanoid(),
      headless: false,
      profile: profileDir,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    await executeCommand({ action: "navigate", id: nanoid(), url }, browser);

    const page = browser.getPage();
    const startTime = Date.now();

    // Wait for user to complete login — detect navigation back to target domain
    let loggedIn = false;
    let lastLoggedUrl = "";
    while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const currentUrl = page.url();
        const currentDomain = new URL(currentUrl).hostname.toLowerCase();
        const targetNorm = targetDomain.toLowerCase();

        if (currentUrl !== lastLoggedUrl) {
          log("auth", `navigated to: ${currentUrl}`);
          lastLoggedUrl = currentUrl;
        }

        const isOnTarget = currentDomain === targetNorm || currentDomain.endsWith("." + targetNorm);
        if (isOnTarget) {
          const isStillLogin = /\/(login|signin|sign-in|sso|auth|oauth|uas\/login|checkpoint)/.test(new URL(currentUrl).pathname);
          if (!isStillLogin) {
            loggedIn = true;
            log("auth", `login complete — ${currentUrl}`);
            break;
          }
        }
      } catch { /* page navigating */ }
    }

    if (!loggedIn) {
      return { success: false, domain: targetDomain, cookies_stored: 0, error: "Login timeout (120s)" };
    }

    // Extract and store cookies
    const context = browser.getContext();
    const cookies = context ? await context.cookies() : [];
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

    return { success: true, domain: targetDomain, cookies_stored: storableCookies.length };
  } finally {
    try {
      const context = browser.getContext();
      if (context) await Promise.race([context.close(), new Promise<void>((r) => setTimeout(r, 4000))]);
    } catch { /* ignore */ }
  }
}

/**
 * Extract cookies directly from Chrome/Firefox SQLite databases.
 * No browser launch needed, Chrome can stay open.
 * Stores extracted cookies in the vault for subsequent use.
 * Always stores under the registrable domain key for consistency.
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

  // Store in vault under same format as interactiveLogin
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

  // Normalize: always store under registrable domain for consistent lookups
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
    if (c.expires == null || c.expires <= 0) return true; // session cookie
    return c.expires > now;
  });
}

/**
 * Retrieve stored auth cookies for a domain from the vault.
 * Filters out expired cookies automatically.
 * Checks both registrable domain key and exact domain key for backward compat.
 */
export async function getStoredAuth(
  domain: string
): Promise<AuthCookie[] | null> {
  // Try registrable domain key first (new normalized format), then exact domain
  const regDomain = getRegistrableDomain(domain);
  const keysToTry = [`auth:${regDomain}`];
  if (domain !== regDomain) keysToTry.push(`auth:${domain}`);

  for (const key of keysToTry) {
    const stored = await getCredential(key);
    if (!stored) continue;
    try {
      const parsed = JSON.parse(stored) as { cookies?: AuthCookie[] };
      const cookies = parsed.cookies;
      if (!cookies || cookies.length === 0) continue;

      const valid = filterExpired(cookies);
      if (valid.length === 0) {
        log("auth", `all ${cookies.length} cookies for ${domain} (key: ${key}) are expired — deleting`);
        await deleteCredential(key);
        continue;
      }
      if (valid.length < cookies.length) {
        log("auth", `filtered ${cookies.length - valid.length} expired cookies for ${domain}`);
      }
      return valid;
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
 *
 * This ensures cookies are available without requiring the user to manually
 * call /v1/auth/steal first.
 */
export async function getAuthCookies(
  domain: string
): Promise<AuthCookie[] | null> {
  // 1. Try vault (fast)
  const vaultCookies = await getStoredAuth(domain);
  if (vaultCookies && vaultCookies.length > 0) return vaultCookies;

  // 2. Auto-extract from browser (bird pattern)
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


