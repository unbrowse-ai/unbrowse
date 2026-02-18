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
 * Requires OpenClaw browser to be running (no local Playwright fallback).
 */

import type { HarEntry } from "./types.js";
import { captureCdpNetworkTraffic } from "./cdp-ws.js";

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

const AUTH_HEADER_BLOCKLIST = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "dnt",
  "host",
  "origin",
  "pragma",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade-insecure-requests",
  "user-agent",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

function shouldCaptureAuthHeader(name: string, value: string): boolean {
  const lower = name.toLowerCase().trim();
  if (!lower || !value || !String(value).trim()) return false;
  if (lower.startsWith(":")) return false; // HTTP/2 pseudo-headers
  if (lower.startsWith("sec-")) return false;
  if (lower.startsWith("proxy-")) return false;
  if (lower.startsWith("x-forwarded-")) return false;
  if (AUTH_HEADER_BLOCKLIST.has(lower)) return false;
  return true;
}

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
    captureUrls?: string[];
    waitMs?: number;
    browserPort?: number;
    cdpHttpBase?: string;
  } = {},
): Promise<LoginResult> {
  const waitMs = opts.waitMs ?? 5000;
  const browserPort = opts.browserPort ?? DEFAULT_PORT;
  const cdpHttpBase = typeof opts.cdpHttpBase === "string" && opts.cdpHttpBase.trim().length > 0
    ? opts.cdpHttpBase.trim().replace(/\/$/, "")
    : "http://127.0.0.1:18800";

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

  // Fallback: use raw CDP WebSocket against the running OpenClaw browser (:18800).
  // This avoids relying on the deprecated REST control port (18791) and also avoids Playwright CDP attach issues.
  try {
    const cookieSeed = (credentials.cookies ?? [])
      .filter((c) => c?.name && c?.value && c?.domain)
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: "/" }));

    const urls = [loginUrl, ...(opts.captureUrls ?? [])];
    const { captured, cookies: allCookies, localStorage, sessionStorage, metaTokens } = await captureCdpNetworkTraffic({
      cdpHttpBase,
      urls,
      waitMs,
      extraHeaders: credentials.headers,
      cookies: cookieSeed,
      keepTypes: new Set(["xhr", "fetch"]),
    });

    const cookieMap: Record<string, string> = {};
    for (const c of allCookies as any[]) {
      if (c?.name && typeof c?.value === "string") cookieMap[c.name] = c.value;
    }

    const capturedEntries: CapturedEntry[] = captured.map((r) => ({
      method: r.method,
      url: r.url,
      headers: r.requestHeaders ?? {},
      resourceType: r.type,
      status: r.status ?? 0,
      responseHeaders: r.responseHeaders ?? {},
      timestamp: r.timestamp,
    }));

    const authHeaders = extractAuthHeaders(capturedEntries, localStorage, sessionStorage);
    for (const [name, value] of Object.entries(metaTokens ?? {})) {
      const ln = name.toLowerCase();
      if ((ln.includes("csrf") || ln.includes("xsrf")) && !authHeaders["x-csrf-token"]) {
        authHeaders["x-csrf-token"] = String(value);
      }
    }

    const harEntries: HarEntry[] = captured.map((r) => ({
      request: {
        method: r.method,
        url: r.url,
        headers: Object.entries(r.requestHeaders ?? {}).map(([name, value]) => ({ name, value: String(value) })),
        cookies: Object.entries(cookieMap).map(([name, value]) => ({ name, value })),
        postData: r.postData ? { text: r.postData } : undefined,
      },
      response: {
        status: r.status ?? 0,
        headers: Object.entries(r.responseHeaders ?? {}).map(([name, value]) => ({ name, value: String(value) })),
        content: r.responseBody != null
          ? { text: r.responseBody, mimeType: r.mimeType, size: r.responseBody.length }
          : undefined,
      },
      time: r.timestamp,
    }));

    return {
      cookies: cookieMap,
      authHeaders,
      baseUrl,
      requestCount: capturedEntries.length,
      har: { log: { entries: harEntries } },
      localStorage: filterAuthStorage(localStorage),
      sessionStorage: filterAuthStorage(sessionStorage),
      metaTokens,
    };
  } catch (err) {
    throw new Error(
      `OpenClaw browser not available (port ${browserPort}) and CDP fallback failed. ` +
        `Start it with: openclaw browser start\n` +
        `Error: ${String((err as Error)?.message ?? err)}`,
    );
  }
}

/** Extract auth-related headers from captured requests. */
export function extractAuthHeaders(
  captured: CapturedEntry[],
  localStorage: Record<string, string>,
  sessionStorage: Record<string, string>
): Record<string, string> {
  const authHeaders: Record<string, string> = {};

  // From captured requests: capture all non-standard headers (blocklist approach).
  for (const entry of captured) {
    for (const [name, value] of Object.entries(entry.headers)) {
      if (shouldCaptureAuthHeader(name, value)) {
        authHeaders[name.toLowerCase()] = String(value);
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
