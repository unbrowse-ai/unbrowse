import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";
import { storeCredential, getCredential } from "../vault/index.js";
import { nanoid } from "nanoid";
import { isDomainMatch } from "../domain.js";

const LOGIN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

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
  const browser = new BrowserManager();

  try {
    await browser.launch({ action: "launch", id: nanoid(), headless: false });
    await executeCommand({ action: "navigate", id: nanoid(), url }, browser);

    const page = browser.getPage();
    const startTime = Date.now();

    // Wait for user to complete login — detect navigation back to target domain
    let loggedIn = false;
    let lastLoggedUrl = "";
    let pollCount = 0;
    console.log(`[auth] waiting for login — target domain: ${targetDomain}`);
    while (Date.now() - startTime < LOGIN_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      pollCount++;
      try {
        const currentUrl = page.url();
        const currentDomain = new URL(currentUrl).hostname.toLowerCase();
        const targetNorm = targetDomain.toLowerCase();

        // Log every URL change (not every poll) so output stays readable
        if (currentUrl !== lastLoggedUrl) {
          console.log(`[auth] navigated to: ${currentUrl}`);
          lastLoggedUrl = currentUrl;
        }

        // Strict check: only match when we are ON the target domain (or a subdomain of
        // it), NOT when we are on a parent domain (e.g. google.com while target is
        // calendar.google.com). isDomainMatch is bidirectional and designed for cookie
        // scope matching — it would fire prematurely on parent domains.
        const isOnTarget = currentDomain === targetNorm || currentDomain.endsWith("." + targetNorm);
        if (isOnTarget) {
          // Also check we are NOT on a login/auth path anymore
          const path = new URL(currentUrl).pathname;
          const isStillLogin = /\/(login|signin|sign-in|sso|auth|oauth)/.test(path);
          if (isStillLogin) {
            console.log(`[auth] on target domain but path looks like login page: ${path} — still waiting`);
          } else {
            loggedIn = true;
            console.log(`[auth] login detected — captured at: ${currentUrl}`);
            break;
          }
        }
      } catch {
        // page may have navigated to about:blank or cross-origin
      }
    }

    if (!loggedIn) {
      console.log(`[auth] login timeout after ${pollCount} polls — last url: ${lastLoggedUrl}`);
      return { success: false, domain: targetDomain, cookies_stored: 0, error: "Login timeout (120s)" };
    }


    // Extract cookies from the browser context
    const context = browser.getContext();
    const cookies = context ? await context.cookies() : [];
    const domainCookies = cookies.filter(
      (c) => isDomainMatch(c.domain, targetDomain)
    );

    if (domainCookies.length === 0) {
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
    await storeCredential(
      `auth:${targetDomain}`,
      JSON.stringify({ cookies: storableCookies })
    );

    return { success: true, domain: targetDomain, cookies_stored: storableCookies.length };
  } finally {
    try {
      const context = browser.getContext();
      if (context) await context.close();
    } catch {
      // browser may already be closed
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

