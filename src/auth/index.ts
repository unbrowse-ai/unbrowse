import * as kuri from "../kuri/client.js";
import { storeCredential, getCredential, deleteCredential } from "../vault/index.js";
import { nanoid } from "nanoid";
import { isDomainMatch, getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const LOGIN_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 2_000;
const MIN_WAIT_MS = 15_000;

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

  log("auth", `interactiveLogin — url: ${url}, domain: ${targetDomain}`);

  // Open URL in the user's default browser (visible, not headless)
  const { exec } = await import("node:child_process");
  const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${openCmd} ${JSON.stringify(url)}`);
  log("auth", `opened ${url} in default browser via ${openCmd}`);

  // Poll extractBrowserAuth until cookies appear or timeout
  const startTime = Date.now();
  while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const result = await extractBrowserAuth(targetDomain);
      if (result.success && result.cookies_stored > 0) {
        log("auth", `login detected — ${result.cookies_stored} cookies captured for ${targetDomain}`);
        return result;
      }
    } catch (err) {
      log("auth", `poll error: ${err instanceof Error ? err.message : err}`);
    }

    // Log progress every 10s
    const elapsed = Date.now() - startTime;
    if (elapsed % 10_000 < POLL_INTERVAL_MS) {
      log("auth", `waiting for login... ${Math.round(elapsed / 1000)}s elapsed`);
    }
  }

  return {
    success: false,
    domain: targetDomain,
    cookies_stored: 0,
    error: `Login timed out after ${LOGIN_TIMEOUT_MS / 1000}s — no cookies detected in browser`,
  };
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
