import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";
import { storeCredential, getCredential } from "../vault/index.js";
import { nanoid } from "nanoid";
import { isDomainMatch, getRegistrableDomain } from "../domain.js";
import { log } from "./logger.js";
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
/** Known auth provider hostnames — these are valid mid-flight redirect destinations. */
const AUTH_PROVIDER_RE = /accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|appleid\.apple\.com|github\.com\/login|facebook\.com\/login/i;

/**
 * When a site redirects unauthenticated users to a marketing page instead of
 * a login flow (e.g. calendar.google.com → workspace.google.com/products/…),
 * derive the correct direct sign-in URL so the user sees the login prompt.
 */
function resolveSignInUrl(targetUrl: string, redirectedUrl: string): string {
  const target = new URL(targetUrl);
  const redirected = new URL(redirectedUrl);

  // Google family: any *.google.com redirect → accounts sign-in with continue param
  if (redirected.hostname.endsWith("google.com") || target.hostname.endsWith("google.com")) {
    return `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(targetUrl)}`;
  }

  // Microsoft family: any *.microsoft.com / *.microsoftonline.com redirect
  if (redirected.hostname.endsWith("microsoft.com") || redirected.hostname.endsWith("microsoftonline.com")) {
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=${encodeURIComponent(targetUrl)}`;
  }

  // Generic fallback: try <target-origin>/login
  return `${target.origin}/login`;
}

export interface LoginResult {
  success: boolean;
  domain: string;
  cookies_stored: number;
  error?: string;
}

/**
 * Open a visible (non-headless) browser for the user to complete login.
 * Waits up to 120s for navigation back to the target domain, then captures cookies.
 */
export async function interactiveLogin(url: string, domain?: string): Promise<LoginResult> {
  const targetDomain = domain ?? new URL(url).hostname;
  const profileDir = getProfilePath(targetDomain);
  const browser = new BrowserManager();
  log("auth", `interactiveLogin called — url: ${url}, targetDomain: ${targetDomain}`);
  log("auth", `persistent profile dir: ${profileDir}`);

  try {
    fs.mkdirSync(profileDir, { recursive: true });
    log("auth", `launching headless:false browser with persistent profile`);
    await browser.launch({ action: "launch", id: nanoid(), headless: false, profile: profileDir });
    log("auth", `browser launched — navigating to ${url}`);
    await executeCommand({ action: "navigate", id: nanoid(), url }, browser);
    log("auth", `initial navigation complete`);

    const page = browser.getPage();

    // Detect marketing-page redirects (e.g. calendar.google.com → workspace.google.com).
    // If we landed somewhere that is neither the target domain nor a known auth provider,
    // navigate directly to the appropriate sign-in URL so the user sees the login prompt.
    await new Promise((r) => setTimeout(r, 1500)); // let redirect settle
    const postNavUrl = page.url();
    const postNavDomain = new URL(postNavUrl).hostname.toLowerCase();
    const targetNormCheck = targetDomain.toLowerCase();
    const isOnTarget = postNavDomain === targetNormCheck || postNavDomain.endsWith("." + targetNormCheck);
    const isOnAuthPage = AUTH_PROVIDER_RE.test(postNavDomain);
    if (!isOnTarget && !isOnAuthPage) {
      const signInUrl = resolveSignInUrl(url, postNavUrl);
      log("auth", `redirected to ${postNavDomain} (not target, not auth provider) — navigating to sign-in: ${signInUrl}`);
      await executeCommand({ action: "navigate", id: nanoid(), url: signInUrl }, browser);
    }

    const startTime = Date.now();

    // Wait for user to complete login — detect navigation back to target domain
    let loggedIn = false;
    let lastLoggedUrl = "";
    let pollCount = 0;
    log("auth", `polling every ${POLL_INTERVAL_MS}ms for up to ${LOGIN_TIMEOUT_MS / 1000}s — waiting for target domain: ${targetDomain}`);
    let loggedIn = false;
    let lastLoggedUrl = "";
    let pollCount = 0;
    log("auth", `polling every ${POLL_INTERVAL_MS}ms for up to ${LOGIN_TIMEOUT_MS / 1000}s — waiting for target domain: ${targetDomain}`);
    while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      pollCount++;
      try {
        const currentUrl = page.url();
        const currentDomain = new URL(currentUrl).hostname.toLowerCase();
        const targetNorm = targetDomain.toLowerCase();

        // Log every URL change (not every poll) so output stays readable
        if (currentUrl !== lastLoggedUrl) {
          log("auth", `navigated to: ${currentUrl}`);
          lastLoggedUrl = currentUrl;
        }

        // Strict check: only match when we are ON the target domain (or a subdomain of
        // it), NOT when we are on a parent domain (e.g. google.com while target is
        // calendar.google.com). isDomainMatch is bidirectional and designed for cookie
        // scope matching — it would fire prematurely on parent domains.
        const isOnTarget = currentDomain === targetNorm || currentDomain.endsWith("." + targetNorm);
        if (isOnTarget) {
          const urlPath = new URL(currentUrl).pathname;
          const isStillLogin = /\/(login|signin|sign-in|sso|auth|oauth)/.test(urlPath);
          if (isStillLogin) {
            log("auth", `on target domain but path looks like login page: ${urlPath} — still waiting`);
          } else {
            loggedIn = true;
            log("auth", `login detected after ${pollCount} polls (${((Date.now() - startTime) / 1000).toFixed(1)}s) — url: ${currentUrl}`);
            break;
          }
        }
      } catch (err) {
        log("auth", `poll error (page may be navigating): ${err}`);
      }
    }

    if (!loggedIn) {
      log("auth", `login timeout after ${pollCount} polls (${LOGIN_TIMEOUT_MS / 1000}s) — last url: ${lastLoggedUrl}`);
      return { success: false, domain: targetDomain, cookies_stored: 0, error: "Login timeout (120s)" };
    }

    // Extract cookies from the browser context
    log("auth", `capturing cookies from browser context`);
    const context = browser.getContext();
    const cookies = context ? await context.cookies() : [];
    log("auth", `total cookies in context: ${cookies.length}`);
    log("auth", `all cookie domains: ${[...new Set(cookies.map((c) => c.domain))].join(", ")}`);

    const domainCookies = cookies.filter((c) => isDomainMatch(c.domain, targetDomain));
    log("auth", `cookies matching ${targetDomain}: ${domainCookies.length} — names: ${domainCookies.map((c) => c.name).join(", ") || "(none)"}`);

    if (domainCookies.length === 0) {
      log("auth", `no cookies matched — check domain filter. targetDomain=${targetDomain}`);
      return { success: false, domain: targetDomain, cookies_stored: 0, error: "No cookies captured for domain" };
    }

    // Store cookies in vault under auth:{domain} — preserve all security attributes
    const storableCookies = domainCookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expires: c.expires,
    }));

    log("auth", `storing ${storableCookies.length} cookies under vault key auth:${targetDomain}`);
    await storeCredential(
      `auth:${targetDomain}`,
      JSON.stringify({ cookies: storableCookies })
    );
    log("auth", `vault write complete — login successful`);

    return { success: true, domain: targetDomain, cookies_stored: storableCookies.length };
  } finally {
    log("auth", `closing browser context (4s timeout)`);
    try {
      const context = browser.getContext();
      if (context) {
        // context.close() can hang indefinitely when the browser has pending
        // navigations or in-flight network requests (common after OAuth flows).
        // Race against a 4s timeout so the HTTP response always returns.
        await Promise.race([
          context.close(),
          new Promise<void>((r) => setTimeout(r, 4000)),
        ]);
      }
    } catch (err) {
      log("auth", `error closing browser context: ${err}`);
    }
    log("auth", `done`);
  }
  }
}

/**
 * Retrieve stored auth cookies for a domain.
 */
export async function getStoredAuth(
  domain: string
): Promise<Array<{
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}> | null> {
  const stored = await getCredential(`auth:${domain}`);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as {
      cookies?: Array<{
        name: string;
        value: string;
        domain: string;
        path?: string;
        secure?: boolean;
        httpOnly?: boolean;
        sameSite?: string;
        expires?: number;
      }>;
    };
    return parsed.cookies ?? null;
  } catch {
    return null;
  }
}

