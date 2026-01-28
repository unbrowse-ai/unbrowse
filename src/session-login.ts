/**
 * Session Login — Credential-based browser session for Docker/cloud environments.
 *
 * When there's no Chrome profile available (Docker, CI, cloud), users can provide
 * credentials and the system will log in via a stealth browser, capturing the
 * resulting cookies/headers for future API calls.
 *
 * Two browser backends:
 *   1. BrowserBase (stealth cloud) — anti-detection, proxy, no local Chrome needed
 *   2. Local Playwright — fallback, launches bundled Chromium with stealth flags
 */

import type { HarEntry } from "./types.js";

export interface LoginCredentials {
  /** Form field selectors → values to fill. e.g. { "#email": "me@x.com", "#password": "..." } */
  formFields?: Record<string, string>;
  /** Selector for the submit button (default: auto-detect form submit) */
  submitSelector?: string;
  /** Headers to inject on every request (e.g. API key auth) */
  headers?: Record<string, string>;
  /** Pre-set cookies to inject before navigation */
  cookies?: Array<{ name: string; value: string; domain: string }>;
}

export interface LoginResult {
  /** Captured cookies after login (name → value) */
  cookies: Record<string, string>;
  /** Auth headers seen in requests after login */
  authHeaders: Record<string, string>;
  /** Base URL derived from the login URL */
  baseUrl: string;
  /** Number of network requests captured */
  requestCount: number;
  /** HAR log for skill generation */
  har: { log: { entries: HarEntry[] } };
  /** localStorage tokens captured from the authenticated page */
  localStorage: Record<string, string>;
  /** sessionStorage tokens captured from the authenticated page */
  sessionStorage: Record<string, string>;
  /** Meta tag tokens (CSRF, etc.) from the page DOM */
  metaTokens: Record<string, string>;
}

interface CapturedEntry {
  method: string;
  url: string;
  headers: Record<string, string>;
  resourceType: string;
  status: number;
  responseHeaders: Record<string, string>;
  timestamp: number;
}

const AUTH_HEADER_NAMES = new Set([
  "authorization", "x-api-key", "api-key", "apikey",
  "x-auth-token", "access-token", "x-access-token",
  "token", "x-token", "x-csrf-token", "x-xsrf-token",
]);

/**
 * Log in via a stealth cloud browser (BrowserBase) or local Playwright.
 *
 * Flow:
 *   1. Launch browser (stealth cloud if API key provided, otherwise local)
 *   2. Inject any pre-set cookies/headers
 *   3. Navigate to login URL
 *   4. Fill form credentials and submit
 *   5. Wait for post-login navigation
 *   6. Visit additional URLs to capture API traffic
 *   7. Extract cookies + auth headers from the authenticated session
 */
export async function loginAndCapture(
  loginUrl: string,
  credentials: LoginCredentials,
  opts: {
    /** BrowserBase API key — if set, uses stealth cloud browser */
    browserUseApiKey?: string;
    /** Additional URLs to visit after login to capture API traffic */
    captureUrls?: string[];
    /** Wait time per page in ms (default: 5000) */
    waitMs?: number;
    /** Proxy country for BrowserBase */
    proxyCountry?: string;
  } = {},
): Promise<LoginResult> {
  const { chromium } = await import("playwright");
  const waitMs = opts.waitMs ?? 5000;
  const captured: CapturedEntry[] = [];
  const pendingRequests = new Map<string, Partial<CapturedEntry>>();

  // Decide browser backend
  let browser: any;
  let context: any;
  let usingStealth = false;

  if (opts.browserUseApiKey) {
    // Use BrowserBase stealth cloud browser
    const { createStealthSession } = await import("./stealth-browser.js");
    const session = await createStealthSession(opts.browserUseApiKey, {
      timeout: 15,
      proxyCountryCode: opts.proxyCountry,
    });

    browser = await chromium.connectOverCDP(session.cdpUrl);
    context = browser.contexts()[0];
    if (!context) {
      context = await browser.newContext();
    }
    usingStealth = true;
  } else {
    // Local Playwright with stealth flags
    context = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    }).then(async (b) => {
      browser = b;
      return b.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });
    });
  }

  // Attach network capture listeners
  function attachListeners(page: any) {
    page.on("request", (req: any) => {
      pendingRequests.set(req.url() + req.method(), {
        method: req.method(),
        url: req.url(),
        headers: req.headers(),
        resourceType: req.resourceType(),
        timestamp: Date.now(),
      });
    });

    page.on("response", (resp: any) => {
      const req = resp.request();
      const key = req.url() + req.method();
      const entry = pendingRequests.get(key);
      if (entry) {
        entry.status = resp.status();
        entry.responseHeaders = resp.headers();
        captured.push(entry as CapturedEntry);
        pendingRequests.delete(key);
      }
    });
  }

  for (const page of context.pages()) {
    attachListeners(page);
  }
  context.on("page", (page: any) => attachListeners(page));

  const page = context.pages()[0] ?? await context.newPage();
  attachListeners(page);

  // Inject pre-set cookies before navigating
  if (credentials.cookies && credentials.cookies.length > 0) {
    await context.addCookies(credentials.cookies);
  }

  // Inject custom headers on all requests
  if (credentials.headers && Object.keys(credentials.headers).length > 0) {
    await context.setExtraHTTPHeaders(credentials.headers);
  }

  // Navigate to login page
  try {
    await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30_000 });
  } catch {
    await page.waitForTimeout(waitMs);
  }

  // Fill form credentials
  const failedFields: string[] = [];
  if (credentials.formFields && Object.keys(credentials.formFields).length > 0) {
    for (const [selector, value] of Object.entries(credentials.formFields)) {
      let filled = false;

      // Try waiting for selector with a retry for slow-loading forms
      for (const timeout of [5_000, 3_000]) {
        try {
          await page.waitForSelector(selector, { timeout });
          await page.fill(selector, value);
          filled = true;
          break;
        } catch {
          // Try clicking + typing if fill doesn't work (some custom inputs)
          try {
            await page.click(selector, { timeout: 2_000 });
            await page.keyboard.type(value, { delay: 50 + Math.random() * 50 });
            filled = true;
            break;
          } catch {
            // Retry with longer timeout
          }
        }
      }

      if (!filled) {
        failedFields.push(selector);
      } else {
        // Small delay between fields to look more human
        await page.waitForTimeout(200 + Math.random() * 300);
      }
    }

    // If any fields failed, try to help diagnose by finding actual form fields
    if (failedFields.length > 0) {
      const actualFields = await page.evaluate(() => {
        const fields: string[] = [];
        document.querySelectorAll("input, select, textarea").forEach((el: any) => {
          if (el.type === "hidden") return;
          const id = el.id ? `#${el.id}` : "";
          const name = el.name ? `[name="${el.name}"]` : "";
          const type = el.type ? `[type="${el.type}"]` : "";
          const placeholder = el.placeholder ? `[placeholder="${el.placeholder.slice(0, 30)}"]` : "";
          const desc = id || name || `${el.tagName.toLowerCase()}${type}${placeholder}`;
          if (desc) fields.push(desc);
        });
        return fields.slice(0, 10);
      });

      const fieldList = actualFields.length > 0
        ? `Found: ${actualFields.join(", ")}`
        : "No form fields detected on page";

      throw new Error(
        `Could not find form field(s): ${failedFields.join(", ")}. ${fieldList}. ` +
        `Try unbrowse_interact to manually inspect the form, or adjust selectors.`
      );
    }

    // Submit the form
    if (credentials.submitSelector) {
      try {
        await page.click(credentials.submitSelector);
      } catch {
        // Try pressing Enter as fallback
        await page.keyboard.press("Enter");
      }
    } else {
      // Auto-detect: try common submit buttons, then Enter
      const submitted = await page.evaluate(() => {
        const btn =
          document.querySelector('button[type="submit"]') ??
          document.querySelector('input[type="submit"]') ??
          document.querySelector('button:not([type])');
        if (btn instanceof HTMLElement) {
          btn.click();
          return true;
        }
        return false;
      });

      if (!submitted) {
        await page.keyboard.press("Enter");
      }
    }

    // Wait for post-login navigation — SPAs may not trigger a traditional
    // navigation, so we use multiple signals: navigation, URL change, or
    // network settle after form submit.
    try {
      await Promise.race([
        page.waitForNavigation({ waitUntil: "networkidle", timeout: 15_000 }),
        page.waitForURL((url: URL) => url.pathname !== new URL(loginUrl).pathname, { timeout: 15_000 }),
      ]);
    } catch {
      // No navigation detected — SPA may handle login inline.
      // Wait for network to settle.
      await page.waitForTimeout(waitMs);
    }

    // Extra wait for SPA post-login API calls (token exchanges, user data, etc.)
    await page.waitForTimeout(2000);
  }

  // Visit additional URLs to capture API traffic in the authenticated session
  const captureUrls = opts.captureUrls ?? [];
  for (const url of captureUrls) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    } catch {
      await page.waitForTimeout(waitMs);
    }
    await page.waitForTimeout(waitMs);
  }

  // Derive base URL from the login URL (needed for cookie extraction and return value)
  const parsedUrl = new URL(loginUrl);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  // Extract cookies from the authenticated session.
  // Use the login URL's domain to also request domain-scoped cookies.
  const browserCookies = await context.cookies([baseUrl]).catch(() => context.cookies());
  const cookies: Record<string, string> = {};
  for (const c of browserCookies) {
    cookies[c.name] = c.value;
  }

  // Also extract cookies from captured Set-Cookie response headers.
  // Some stealth browsers don't expose cookies via context.cookies() but
  // the Set-Cookie headers are visible in captured network responses.
  for (const entry of captured) {
    for (const [name, value] of Object.entries(entry.responseHeaders ?? {})) {
      if (name.toLowerCase() === "set-cookie") {
        // Each Set-Cookie header is one cookie. Don't split on commas
        // because Expires dates contain commas (e.g., "Thu, 01 Jan 2026").
        const eq = value.indexOf("=");
        if (eq > 0) {
          const cookieName = value.slice(0, eq).trim();
          const rest = value.slice(eq + 1);
          const semi = rest.indexOf(";");
          const cookieValue = semi > 0 ? rest.slice(0, semi).trim() : rest.trim();
          if (cookieName && cookieValue) {
            cookies[cookieName] = cookieValue;
          }
        }
      }
    }
  }

  // Extract auth headers seen in captured requests
  const authHeaders: Record<string, string> = {};
  for (const entry of captured) {
    for (const [name, value] of Object.entries(entry.headers)) {
      if (AUTH_HEADER_NAMES.has(name.toLowerCase())) {
        authHeaders[name.toLowerCase()] = value;
      }
    }
  }

  // ── Extract client-side auth state ────────────────────────────────
  // Modern SPAs store auth in localStorage/sessionStorage (JWTs, access tokens)
  // and embed CSRF tokens in meta tags. These are invisible to cookie/header capture.

  let localStorage: Record<string, string> = {};
  let sessionStorage: Record<string, string> = {};
  let metaTokens: Record<string, string> = {};

  try {
    const clientState = await page.evaluate(() => {
      // Keywords that indicate auth-related storage entries
      const authKeywords = /token|auth|session|jwt|access|refresh|csrf|xsrf|key|cred|user|login|bearer/i;

      // Grab localStorage entries matching auth keywords
      const ls: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && authKeywords.test(key)) {
          const val = window.localStorage.getItem(key);
          if (val) ls[key] = val;
        }
      }

      // Grab sessionStorage entries matching auth keywords
      const ss: Record<string, string> = {};
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        if (key && authKeywords.test(key)) {
          const val = window.sessionStorage.getItem(key);
          if (val) ss[key] = val;
        }
      }

      // Extract meta tag tokens (CSRF, API keys, etc.)
      const meta: Record<string, string> = {};
      const metaKeywords = /csrf|xsrf|token|nonce|api[-_]?key|auth/i;
      document.querySelectorAll("meta[name], meta[property], meta[http-equiv]").forEach((el) => {
        const name = el.getAttribute("name") || el.getAttribute("property") || el.getAttribute("http-equiv") || "";
        const content = el.getAttribute("content") || "";
        if (name && content && metaKeywords.test(name)) {
          meta[name] = content;
        }
      });

      // Also check common JS globals that SPAs use for auth
      const win = window as any;
      const globalKeys = [
        "__NEXT_DATA__", "__NUXT__", "__INITIAL_STATE__",
        "_csrf", "csrfToken", "CSRF_TOKEN",
      ];
      for (const gk of globalKeys) {
        if (win[gk]) {
          try {
            const val = typeof win[gk] === "string" ? win[gk] : JSON.stringify(win[gk]);
            // Only store if it looks like it contains auth data
            if (val && authKeywords.test(val) && val.length < 10000) {
              ls[`__global:${gk}`] = val;
            }
          } catch { /* skip non-serializable */ }
        }
      }

      return { localStorage: ls, sessionStorage: ss, metaTokens: meta };
    });

    localStorage = clientState.localStorage;
    sessionStorage = clientState.sessionStorage;
    metaTokens = clientState.metaTokens;

    // Promote any JWT/bearer tokens found in storage to authHeaders
    // so they're automatically used in unbrowse_replay fetch calls
    for (const [key, value] of [...Object.entries(localStorage), ...Object.entries(sessionStorage)]) {
      const lk = key.toLowerCase();
      // JWT detection: starts with eyJ (base64 {"alg":...)
      if (value.startsWith("eyJ") || /^Bearer\s/i.test(value)) {
        const tokenValue = value.startsWith("eyJ") ? `Bearer ${value}` : value;
        // Use the most specific key name we can find
        if (lk.includes("access") || lk.includes("auth") || lk.includes("token")) {
          authHeaders["authorization"] = tokenValue;
        }
      }
      // Also grab explicit CSRF tokens for the header
      if (lk.includes("csrf") || lk.includes("xsrf")) {
        authHeaders["x-csrf-token"] = value;
      }
    }

    // Same for meta tokens
    for (const [name, value] of Object.entries(metaTokens)) {
      const ln = name.toLowerCase();
      if (ln.includes("csrf") || ln.includes("xsrf")) {
        authHeaders["x-csrf-token"] = value;
      }
    }
  } catch {
    // Page might be navigated away or context closed — non-critical
  }

  // Clean up
  if (usingStealth) {
    await browser?.close().catch(() => {});
  } else {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }

  // Convert to HAR format
  const harEntries: HarEntry[] = captured.map((entry) => ({
    request: {
      method: entry.method,
      url: entry.url,
      headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value })),
      cookies: Object.entries(cookies).map(([name, value]) => ({ name, value })),
    },
    response: {
      status: entry.status,
      headers: Object.entries(entry.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
    },
    time: entry.timestamp,
  }));

  return {
    cookies,
    authHeaders,
    baseUrl,
    requestCount: captured.length,
    har: { log: { entries: harEntries } },
    localStorage,
    sessionStorage,
    metaTokens,
  };
}
