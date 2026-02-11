/**
 * Browser Replay — Execute API requests through browser for authentic fingerprints.
 *
 * Uses page.evaluate() to run fetch inside the browser context, which means:
 * - Real TLS fingerprint (JA3/JA4 matches Chrome/Firefox)
 * - Real HTTP/2 SETTINGS and pseudo-header ordering
 * - Automatic Sec-CH-UA, Sec-Fetch-* headers
 * - Proper header ordering
 * - Cookies sent automatically for same-origin
 */

import type { Page, BrowserContext } from "playwright-core";

export interface ReplayRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;
}

export interface ReplayResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: string;
  ok: boolean;
}

/**
 * Execute a fetch request inside the browser context.
 *
 * The browser handles TLS, HTTP/2, and adds all fingerprint-sensitive headers.
 * We only need to provide auth headers (Bearer tokens, API keys, etc.).
 */
export async function replayViaBrowser(
  page: Page,
  request: ReplayRequest,
): Promise<ReplayResponse> {
  const { url, method, headers = {}, body, timeout = 30000 } = request;

  // Execute fetch inside browser context
  const result = await page.evaluate(
    async ({ url, method, headers, body, timeout }) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(url, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          credentials: "include", // Send cookies
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Extract response headers
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        // Get response body as text
        const data = await response.text();

        return {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          data,
          ok: response.ok,
        };
      } catch (err) {
        clearTimeout(timeoutId);
        const error = err as Error;
        if (error.name === "AbortError") {
          return {
            status: 0,
            statusText: "Request timed out",
            headers: {},
            data: "",
            ok: false,
          };
        }
        return {
          status: 0,
          statusText: error.message || "Request failed",
          headers: {},
          data: "",
          ok: false,
        };
      }
    },
    { url, method, headers, body, timeout },
  );

  return result;
}

/**
 * Inject cookies into browser context before making requests.
 */
export async function injectCookies(
  context: BrowserContext,
  cookies: Record<string, string>,
  domain: string,
): Promise<void> {
  const cookieObjects = Object.entries(cookies).map(([name, value]) => ({
    name,
    value,
    domain: domain.startsWith(".") ? domain : `.${domain}`,
    path: "/",
  }));

  if (cookieObjects.length > 0) {
    await context.addCookies(cookieObjects);
  }
}

/**
 * Inject localStorage values into a page.
 */
export async function injectLocalStorage(
  page: Page,
  storage: Record<string, string>,
): Promise<void> {
  if (Object.keys(storage).length === 0) return;

  await page.evaluate((items) => {
    for (const [key, value] of Object.entries(items)) {
      localStorage.setItem(key, value);
    }
  }, storage);
}

/**
 * Inject sessionStorage values into a page.
 */
export async function injectSessionStorage(
  page: Page,
  storage: Record<string, string>,
): Promise<void> {
  if (Object.keys(storage).length === 0) return;

  await page.evaluate((items) => {
    for (const [key, value] of Object.entries(items)) {
      sessionStorage.setItem(key, value);
    }
  }, storage);
}

/**
 * Navigate to base URL to establish origin context, then inject auth.
 * Required for same-origin cookie/localStorage access.
 */
export async function setupPageForDomain(
  page: Page,
  context: BrowserContext,
  baseUrl: string,
  auth: {
    cookies?: Record<string, string>;
    localStorage?: Record<string, string>;
    sessionStorage?: Record<string, string>;
  },
): Promise<void> {
  const url = new URL(baseUrl);
  const domain = url.hostname;

  // Inject cookies at context level (works for all pages)
  if (auth.cookies && Object.keys(auth.cookies).length > 0) {
    await injectCookies(context, auth.cookies, domain);
  }

  // Navigate to establish origin (needed for localStorage/sessionStorage)
  // Use a lightweight request - just the base domain
  const currentUrl = page.url();
  if (!currentUrl.includes(domain)) {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {
      // If main page fails, try a simple path
      return page.goto(`${url.origin}/favicon.ico`, { timeout: 5000 }).catch(() => {});
    });
  }

  // Inject storage after navigation (requires same-origin)
  if (auth.localStorage && Object.keys(auth.localStorage).length > 0) {
    await injectLocalStorage(page, auth.localStorage);
  }
  if (auth.sessionStorage && Object.keys(auth.sessionStorage).length > 0) {
    await injectSessionStorage(page, auth.sessionStorage);
  }
}
