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

  console.log(`[auth] interactiveLogin called — url: ${url}, targetDomain: ${targetDomain}`);

  try {
    console.log(`[auth] launching headless:false browser`);
    await browser.launch({ action: "launch", id: nanoid(), headless: false });
    console.log(`[auth] browser launched — navigating to ${url}`);
    await executeCommand({ action: "navigate", id: nanoid(), url }, browser);
    console.log(`[auth] initial navigation complete`);

    const page = browser.getPage();
    const startTime = Date.now();

    // Wait for user to complete login — detect navigation back to target domain
    let loggedIn = false;
    let lastLoggedUrl = "";
    let pollCount = 0;
    console.log(`[auth] polling every ${POLL_INTERVAL_MS}ms for up to ${LOGIN_TIMEOUT_MS / 1000}s — waiting for target domain: ${targetDomain}`);
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
            console.log(`[auth] login detected after ${pollCount} polls (${((Date.now() - startTime) / 1000).toFixed(1)}s) — url: ${currentUrl}`);
            break;
          }
        }
      } catch (err) {
        console.log(`[auth] poll error (page may be navigating): ${err}`);
      }
    }

    if (!loggedIn) {
      console.log(`[auth] login timeout after ${pollCount} polls (${LOGIN_TIMEOUT_MS / 1000}s) — last url: ${lastLoggedUrl}`);
      return { success: false, domain: targetDomain, cookies_stored: 0, error: "Login timeout (120s)" };
    }

    // Extract cookies from the browser context
    console.log(`[auth] capturing cookies from browser context`);
    const context = browser.getContext();
    const cookies = context ? await context.cookies() : [];
    console.log(`[auth] total cookies in context: ${cookies.length}`);
    console.log(`[auth] all cookie domains: ${[...new Set(cookies.map((c) => c.domain))].join(", ")}`);

    const domainCookies = cookies.filter((c) => isDomainMatch(c.domain, targetDomain));
    console.log(`[auth] cookies matching ${targetDomain}: ${domainCookies.length} — names: ${domainCookies.map((c) => c.name).join(", ") || "(none)"}`);

    if (domainCookies.length === 0) {
      console.log(`[auth] no cookies matched — check domain filter. targetDomain=${targetDomain}`);
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

    console.log(`[auth] storing ${storableCookies.length} cookies under vault key auth:${targetDomain}`);
    await storeCredential(
      `auth:${targetDomain}`,
      JSON.stringify({ cookies: storableCookies })
    );
    console.log(`[auth] vault write complete — login successful`);

    return { success: true, domain: targetDomain, cookies_stored: storableCookies.length };
  } finally {
    console.log(`[auth] closing browser context (4s timeout)`);
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
      console.log(`[auth] error closing browser context: ${err}`);
    }
    console.log(`[auth] done`);
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

