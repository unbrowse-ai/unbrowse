/**
 * Session Login — Credential-based browser session using OpenClaw's browser API.
 *
 * When there's no Chrome profile available (Docker, CI, cloud), users can provide
 * credentials and the system will log in via OpenClaw's managed browser, capturing
 * the resulting cookies/headers for future API calls.
 *
 * Browser control API (port 18791):
 *   POST /start             — start browser if not running
 *   POST /navigate          — navigate to URL
 *   GET  /snapshot          — get page state with element refs
 *   POST /act               — click, type, etc.
 *   GET  /requests          — captured network requests
 *   GET  /cookies           — all cookies
 *   GET  /storage/local     — localStorage
 *   GET  /storage/session   — sessionStorage
 *
 * Fallback: If OpenClaw browser is unavailable, uses stealth browser or Playwright.
 */

import type { HarEntry } from "./types.js";

const DEFAULT_PORT = 18791;

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

/** Check if OpenClaw browser is available and start it if needed. */
async function ensureBrowserRunning(port: number): Promise<boolean> {
  try {
    const statusResp = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!statusResp.ok) return false;
    const status = await statusResp.json() as { running?: boolean };

    if (!status.running) {
      const startResp = await fetch(`http://127.0.0.1:${port}/start`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
      });
      if (!startResp.ok) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Navigate to URL via OpenClaw browser API. */
async function navigateTo(url: string, port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(30000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Get snapshot with element refs. */
async function getSnapshot(port: number): Promise<{ elements?: Array<{ ref: string; role?: string; name?: string; tag?: string }> }> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/snapshot?interactive=true`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return {};
    return await resp.json();
  } catch {
    return {};
  }
}

/** Execute browser action (click, type, etc.). */
async function act(port: number, action: { kind: string; ref?: string; selector?: string; text?: string }): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/act`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
      signal: AbortSignal.timeout(15000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Wait for a condition via OpenClaw API. */
async function waitFor(port: number, opts: { url?: string; load?: string; timeoutMs?: number }): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Set cookies via OpenClaw browser API. */
async function setCookies(port: number, cookies: Array<{ name: string; value: string; domain: string }>): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/cookies/set`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cookies }),
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Set extra HTTP headers via OpenClaw browser API. */
async function setHeaders(port: number, headers: Record<string, string>): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/set/headers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ headers }),
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Fetch captured requests from OpenClaw browser. */
async function fetchRequests(port: number, clear = false): Promise<CapturedEntry[]> {
  try {
    const url = new URL(`http://127.0.0.1:${port}/requests`);
    if (clear) url.searchParams.set("clear", "true");

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];

    const data = await resp.json() as { requests?: Array<{
      id: string;
      timestamp: string;
      method: string;
      url: string;
      resourceType: string;
      status?: number;
      headers?: Record<string, string>;
      responseHeaders?: Record<string, string>;
    }> };

    return (data.requests ?? []).map((r) => ({
      method: r.method,
      url: r.url,
      headers: r.headers ?? {},
      resourceType: r.resourceType,
      status: r.status ?? 0,
      responseHeaders: r.responseHeaders ?? {},
      timestamp: r.timestamp ? new Date(r.timestamp).getTime() : Date.now(),
    }));
  } catch {
    return [];
  }
}

/** Fetch cookies from OpenClaw browser. */
async function fetchCookies(port: number): Promise<Record<string, string>> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/cookies`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return {};

    const data = await resp.json() as { cookies?: Array<{ name: string; value: string }> };
    const cookies: Record<string, string> = {};
    for (const c of data.cookies ?? []) {
      cookies[c.name] = c.value;
    }
    return cookies;
  } catch {
    return {};
  }
}

/** Fetch localStorage from OpenClaw browser. */
async function fetchStorage(port: number, kind: "local" | "session"): Promise<Record<string, string>> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/storage/${kind}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return {};
    const data = await resp.json() as { storage?: Record<string, string> };
    return data.storage ?? {};
  } catch {
    return {};
  }
}

/** Find element ref by CSS selector using snapshot. */
async function findRefBySelector(port: number, selector: string): Promise<string | null> {
  // For now, use the selector directly with act() - OpenClaw supports CSS selectors
  return null;
}

/**
 * Log in via OpenClaw's browser API or fall back to Playwright.
 */
export async function loginAndCapture(
  loginUrl: string,
  credentials: LoginCredentials,
  opts: {
    browserUseApiKey?: string;
    captureUrls?: string[];
    waitMs?: number;
    proxyCountry?: string;
    browserPort?: number;
  } = {},
): Promise<LoginResult> {
  const waitMs = opts.waitMs ?? 5000;
  const browserPort = opts.browserPort ?? DEFAULT_PORT;

  // Derive base URL
  const parsedUrl = new URL(loginUrl);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;

  // Try OpenClaw browser first
  if (await ensureBrowserRunning(browserPort)) {
    // Clear existing requests
    await fetchRequests(browserPort, true);

    // Inject pre-set cookies
    if (credentials.cookies && credentials.cookies.length > 0) {
      await setCookies(browserPort, credentials.cookies);
    }

    // Inject custom headers
    if (credentials.headers && Object.keys(credentials.headers).length > 0) {
      await setHeaders(browserPort, credentials.headers);
    }

    // Navigate to login page
    await navigateTo(loginUrl, browserPort);
    await new Promise(r => setTimeout(r, 3000)); // Wait for page load

    // Fill form credentials using act() with selectors
    if (credentials.formFields && Object.keys(credentials.formFields).length > 0) {
      for (const [selector, value] of Object.entries(credentials.formFields)) {
        // Type into the field using CSS selector
        await act(browserPort, { kind: "type", selector, text: value });
        await new Promise(r => setTimeout(r, 300)); // Small delay between fields
      }

      // Submit the form
      if (credentials.submitSelector) {
        await act(browserPort, { kind: "click", selector: credentials.submitSelector });
      } else {
        // Try common submit selectors
        const submitted = await act(browserPort, { kind: "click", selector: 'button[type="submit"]' }) ||
                          await act(browserPort, { kind: "click", selector: 'input[type="submit"]' }) ||
                          await act(browserPort, { kind: "press", text: "Enter" });
      }

      // Wait for navigation/network settle
      await waitFor(browserPort, { load: "networkidle", timeoutMs: 15000 });
      await new Promise(r => setTimeout(r, 2000)); // Extra wait for SPA
    }

    // Visit additional URLs to capture API traffic
    const captureUrls = opts.captureUrls ?? [];
    for (const url of captureUrls) {
      await navigateTo(url, browserPort);
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Fetch captured data
    const [captured, cookies, localStorage, sessionStorage] = await Promise.all([
      fetchRequests(browserPort),
      fetchCookies(browserPort),
      fetchStorage(browserPort, "local"),
      fetchStorage(browserPort, "session"),
    ]);

    // Extract auth headers from captured requests
    const authHeaders = extractAuthHeaders(captured, localStorage, sessionStorage);

    // Convert to HAR
    const har = toHar(captured, cookies);

    return {
      cookies,
      authHeaders,
      baseUrl,
      requestCount: captured.length,
      har,
      localStorage: filterAuthStorage(localStorage),
      sessionStorage: filterAuthStorage(sessionStorage),
      metaTokens: {}, // TODO: Could add /evaluate endpoint call
    };
  }

  // Fallback: Use Playwright directly (existing implementation)
  return loginViaPlaywright(loginUrl, credentials, opts);
}

/** Extract auth-related headers from captured requests. */
function extractAuthHeaders(
  captured: CapturedEntry[],
  localStorage: Record<string, string>,
  sessionStorage: Record<string, string>
): Record<string, string> {
  const authHeaders: Record<string, string> = {};

  // From captured requests
  for (const entry of captured) {
    for (const [name, value] of Object.entries(entry.headers)) {
      if (AUTH_HEADER_NAMES.has(name.toLowerCase())) {
        authHeaders[name.toLowerCase()] = value;
      }
    }
  }

  // Promote JWT tokens from storage
  for (const [key, value] of [...Object.entries(localStorage), ...Object.entries(sessionStorage)]) {
    const lk = key.toLowerCase();
    if (value.startsWith("eyJ") || /^Bearer\s/i.test(value)) {
      const tokenValue = value.startsWith("eyJ") ? `Bearer ${value}` : value;
      if (lk.includes("access") || lk.includes("auth") || lk.includes("token")) {
        authHeaders["authorization"] = tokenValue;
      }
    }
    if (lk.includes("csrf") || lk.includes("xsrf")) {
      authHeaders["x-csrf-token"] = value;
    }
  }

  return authHeaders;
}

/** Filter storage to auth-related keys only. */
function filterAuthStorage(storage: Record<string, string>): Record<string, string> {
  const authKeywords = /token|auth|session|jwt|access|refresh|csrf|xsrf|key|cred|user|login|bearer/i;
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(storage)) {
    if (authKeywords.test(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/** Convert captured entries to HAR format. */
function toHar(captured: CapturedEntry[], cookies: Record<string, string>): { log: { entries: HarEntry[] } } {
  const entries: HarEntry[] = captured.map((entry) => ({
    request: {
      method: entry.method,
      url: entry.url,
      headers: Object.entries(entry.headers).map(([name, value]) => ({ name, value })),
      cookies: Object.entries(cookies).map(([name, value]) => ({ name, value })),
    },
    response: {
      status: entry.status,
      headers: Object.entries(entry.responseHeaders).map(([name, value]) => ({ name, value })),
    },
    time: entry.timestamp,
  }));
  return { log: { entries } };
}

/**
 * Fallback: Log in via Playwright when OpenClaw browser is unavailable.
 */
async function loginViaPlaywright(
  loginUrl: string,
  credentials: LoginCredentials,
  opts: {
    browserUseApiKey?: string;
    captureUrls?: string[];
    waitMs?: number;
    proxyCountry?: string;
  } = {},
): Promise<LoginResult> {
  const { chromium } = await import("playwright");
  const waitMs = opts.waitMs ?? 5000;
  const captured: CapturedEntry[] = [];
  const pendingRequests = new Map<string, Partial<CapturedEntry>>();

  let browser: any;
  let context: any;
  let usingStealth = false;

  // Use stealth browser if API key provided
  if (opts.browserUseApiKey) {
    const { createStealthSession } = await import("./stealth-browser.js");
    const session = await createStealthSession(opts.browserUseApiKey, {
      timeout: 15,
      proxyCountryCode: opts.proxyCountry,
    });
    browser = await chromium.connectOverCDP(session.cdpUrl);
    context = browser.contexts()[0] ?? await browser.newContext();
    usingStealth = true;
  } else {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    });
  }

  // Attach network listeners
  const attachListeners = (page: any) => {
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
  };

  for (const page of context.pages()) attachListeners(page);
  context.on("page", attachListeners);

  const page = context.pages()[0] ?? await context.newPage();
  attachListeners(page);

  // Inject cookies/headers
  if (credentials.cookies?.length) await context.addCookies(credentials.cookies);
  if (credentials.headers) await context.setExtraHTTPHeaders(credentials.headers);

  // Navigate and fill form
  try {
    await page.goto(loginUrl, { waitUntil: "networkidle", timeout: 30000 });
  } catch {
    await page.waitForTimeout(waitMs);
  }

  if (credentials.formFields) {
    for (const [selector, value] of Object.entries(credentials.formFields)) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        await page.fill(selector, value);
        await page.waitForTimeout(200);
      } catch {
        // Field not found
      }
    }

    // Submit
    if (credentials.submitSelector) {
      await page.click(credentials.submitSelector).catch(() => page.keyboard.press("Enter"));
    } else {
      await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]') ??
                    document.querySelector('input[type="submit"]');
        if (btn instanceof HTMLElement) btn.click();
      });
    }

    try {
      await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 });
    } catch {
      await page.waitForTimeout(waitMs);
    }
  }

  // Visit capture URLs
  for (const url of opts.captureUrls ?? []) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    } catch {
      await page.waitForTimeout(waitMs);
    }
  }

  // Extract cookies and storage
  const browserCookies = await context.cookies();
  const cookies: Record<string, string> = {};
  for (const c of browserCookies) cookies[c.name] = c.value;

  let localStorage: Record<string, string> = {};
  let sessionStorage: Record<string, string> = {};

  try {
    const clientState = await page.evaluate(() => {
      const authKeywords = /token|auth|session|jwt|access|refresh|csrf|xsrf|key|cred|user|login|bearer/i;
      const ls: Record<string, string> = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && authKeywords.test(key)) {
          const val = window.localStorage.getItem(key);
          if (val) ls[key] = val;
        }
      }
      const ss: Record<string, string> = {};
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i);
        if (key && authKeywords.test(key)) {
          const val = window.sessionStorage.getItem(key);
          if (val) ss[key] = val;
        }
      }
      return { localStorage: ls, sessionStorage: ss };
    });
    localStorage = clientState.localStorage;
    sessionStorage = clientState.sessionStorage;
  } catch { }

  // Cleanup
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});

  const parsedUrl = new URL(loginUrl);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const authHeaders = extractAuthHeaders(captured, localStorage, sessionStorage);

  return {
    cookies,
    authHeaders,
    baseUrl,
    requestCount: captured.length,
    har: toHar(captured, cookies),
    localStorage,
    sessionStorage,
    metaTokens: {},
  };
}
