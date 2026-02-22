import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";
import { storeCredential, getCredential } from "../vault/index.js";
import { nanoid } from "nanoid";
import { isDomainMatch, getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const LOGIN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

/**
 * Returns the main Chrome profile path for the current platform.
 * Returns null if the path doesn't exist.
 */
function getMainChromeProfilePath(): string | null {
  const platform = process.platform;
  let profilePath: string;
  if (platform === "darwin") {
    profilePath = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "Default");
  } else if (platform === "win32") {
    profilePath = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data", "Default");
  } else {
    profilePath = path.join(os.homedir(), ".config", "google-chrome", "Default");
  }
  return fs.existsSync(profilePath) ? profilePath : null;
}

/**
 * Returns the Chrome user data dir (parent of Default profile).
 */
function getChromeUserDataDir(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  } else if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Google", "Chrome", "User Data");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

/**
 * Check if Chrome is currently running by looking for the SingletonLock file
 * in Chrome's user data directory.
 */
function isChromeRunning(): boolean {
  const userDataDir = getChromeUserDataDir();
  const lockPath = path.join(userDataDir, "SingletonLock");
  try {
    // On macOS/Linux, SingletonLock is a symlink created when Chrome launches
    const stat = fs.lstatSync(lockPath);
    return stat.isSymbolicLink() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Returns the Chrome executable path for the current platform.
 */
function getChromeExecutablePath(): string | null {
  const platform = process.platform;
  if (platform === "darwin") {
    const p = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    return fs.existsSync(p) ? p : null;
  } else if (platform === "win32") {
    const candidates = [
      path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }
  // Linux
  const candidates = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/**
 * Returns the persistent profile directory for a given domain.
 * Stored under ~/.unbrowse/profiles/<registrableDomain>.
 * Exporting so capture/execute can also launch with the profile if needed.
 */
export function getProfilePath(domain: string): string {
  return path.join(os.homedir(), ".unbrowse", "profiles", getRegistrableDomain(domain));
}
/** Known auth provider hostnames — these are valid mid-flight redirect destinations. */
const AUTH_PROVIDER_RE = /accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|appleid\.apple\.com|github\.com\/login|facebook\.com\/login|login\.salesforce\.com|okta\.com\/login|ping.*\.com\/as\/authorization/i;

/**
 * Lookup table of known services that redirect unauthenticated users to a
 * marketing or product page instead of a login flow. Each entry matches on
 * the redirected hostname OR the target hostname, and returns the direct
 * sign-in URL to navigate to instead.
 *
 * To add a new provider: append an entry with a `match` predicate and a
 * `signIn` function that returns the correct login URL.
 */
const SIGN_IN_PROVIDERS: Array<{
  match: (redirectedHost: string, targetHost: string) => boolean;
  signIn: (targetUrl: string) => string;
}> = [
  // Google (Calendar, Drive, Gmail, Docs, etc.)
  {
    match: (r, t) => r.endsWith("google.com") || t.endsWith("google.com"),
    signIn: (t) => `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(t)}`,
  },
  // Microsoft / Office 365 / Teams / Outlook
  {
    match: (r, t) =>
      r.endsWith("microsoft.com") || r.endsWith("microsoftonline.com") ||
      t.endsWith("microsoft.com") || t.endsWith("office.com") || t.endsWith("live.com"),
    signIn: (t) => `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?redirect_uri=${encodeURIComponent(t)}`,
  },
  // GitHub
  {
    match: (r, t) => r.endsWith("github.com") || t.endsWith("github.com"),
    signIn: (t) => `https://github.com/login?return_to=${encodeURIComponent(new URL(t).pathname)}`,
  },
  // Notion
  {
    match: (r, t) => r.endsWith("notion.so") || t.endsWith("notion.so"),
    signIn: () => "https://www.notion.so/login",
  },
  // LinkedIn
  {
    match: (r, t) => r.endsWith("linkedin.com") || t.endsWith("linkedin.com"),
    signIn: () => "https://www.linkedin.com/login",
  },
  // Twitter / X
  {
    match: (r, t) =>
      r.endsWith("twitter.com") || r.endsWith("x.com") ||
      t.endsWith("twitter.com") || t.endsWith("x.com"),
    signIn: () => "https://x.com/i/flow/login",
  },
  // Slack
  {
    match: (r, t) => r.endsWith("slack.com") || t.endsWith("slack.com"),
    signIn: () => "https://slack.com/signin",
  },
  // Atlassian (Jira, Confluence)
  {
    match: (r, t) =>
      r.endsWith("atlassian.com") || r.endsWith("atlassian.net") ||
      t.endsWith("atlassian.com") || t.endsWith("atlassian.net"),
    signIn: () => "https://id.atlassian.com/login",
  },
  // Salesforce
  {
    match: (r, t) => r.endsWith("salesforce.com") || t.endsWith("salesforce.com"),
    signIn: () => "https://login.salesforce.com",
  },
  // Figma
  {
    match: (r, t) => r.endsWith("figma.com") || t.endsWith("figma.com"),
    signIn: () => "https://www.figma.com/login",
  },
  // Airtable
  {
    match: (r, t) => r.endsWith("airtable.com") || t.endsWith("airtable.com"),
    signIn: () => "https://airtable.com/login",
  },
  // Dropbox
  {
    match: (r, t) => r.endsWith("dropbox.com") || t.endsWith("dropbox.com"),
    signIn: () => "https://www.dropbox.com/login",
  },
  // HubSpot
  {
    match: (r, t) => r.endsWith("hubspot.com") || t.endsWith("hubspot.com"),
    signIn: () => "https://app.hubspot.com/login",
  },
];

/**
 * When a site redirects unauthenticated users to a marketing page instead of
 * a login flow, derive the correct direct sign-in URL.
 * Falls back to probing common login paths on the original target origin.
 */
function resolveSignInUrl(targetUrl: string, redirectedUrl: string): string {
  const targetHost = new URL(targetUrl).hostname.toLowerCase();
  const redirectedHost = new URL(redirectedUrl).hostname.toLowerCase();

  for (const provider of SIGN_IN_PROVIDERS) {
    if (provider.match(redirectedHost, targetHost)) {
      return provider.signIn(targetUrl);
    }
  }

  // Generic fallback: try common login paths on the original target.
  // We return the first one; if it's wrong the user can pass the login
  // URL directly to /v1/auth/login instead of the target URL.
  const origin = new URL(targetUrl).origin;
  const commonPaths = ["/login", "/signin", "/sign-in", "/auth/login", "/account/login", "/user/login"];
  return `${origin}${commonPaths[0]}`; // navigate to /login and let the user correct if needed
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
export async function interactiveLogin(
  url: string,
  domain?: string,
  options?: { yolo?: boolean }
): Promise<LoginResult> {
  const targetDomain = domain ?? new URL(url).hostname;

  // Yolo mode: use the user's main Chrome profile instead of an isolated one
  let profileDir: string;
  let executablePath: string | undefined;
  if (options?.yolo) {
    const chromePath = getMainChromeProfilePath();
    if (!chromePath) {
      return { success: false, domain: targetDomain, cookies_stored: 0, error: "Chrome profile not found. Is Google Chrome installed?" };
    }
    if (isChromeRunning()) {
      return { success: false, domain: targetDomain, cookies_stored: 0, error: "Chrome is running. Please close Chrome and try again." };
    }
    const chromeExe = getChromeExecutablePath();
    if (!chromeExe) {
      return { success: false, domain: targetDomain, cookies_stored: 0, error: "Chrome executable not found. Is Google Chrome installed?" };
    }
    // Use the parent dir (User Data dir) as the profile root, with "Default" as the profile
    profileDir = getChromeUserDataDir();
    executablePath = chromeExe;
    log("auth", `yolo mode — using main Chrome profile: ${chromePath}`);
    log("auth", `yolo mode — Chrome executable: ${executablePath}`);
  } else {
    profileDir = getProfilePath(targetDomain);
  }

  const browser = new BrowserManager();
  log("auth", `interactiveLogin called — url: ${url}, targetDomain: ${targetDomain}, yolo: ${!!options?.yolo}`);
  log("auth", `persistent profile dir: ${profileDir}`);

  try {
    fs.mkdirSync(profileDir, { recursive: true });
    log("auth", `launching headless:false browser with ${options?.yolo ? "main Chrome" : "persistent"} profile`);
    await browser.launch({
      action: "launch",
      id: nanoid(),
      headless: false,
      profile: profileDir,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ...(executablePath ? { executablePath } : {}),
    });
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


