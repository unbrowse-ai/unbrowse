/**
 * CDP Capture — Live network capture via clawdbot's browser control API.
 *
 * Uses the browser control HTTP server (port 18791) which wraps Playwright's
 * network capture. Works with both `clawd` (managed Playwright) and `chrome`
 * (extension relay) profiles — no Chrome extension required for `clawd`.
 *
 * Browser control API (port 18791):
 *   GET  /requests              — captured network requests (max 500)
 *   GET  /requests?filter=api   — filter by URL substring
 *   GET  /requests?clear=true   — clear buffer after reading
 *   POST /response/body         — get response body for a request ID
 *   GET  /cookies               — all cookies from the browser
 *   POST /cookies/set           — set a cookie
 *   POST /cookies/clear         — clear cookies
 *
 * Playwright captures requests via page.on("request") / page.on("response")
 * events. The control server at 18791 exposes them as a REST API.
 */

import type { HarEntry } from "./types.js";

/** Default browser control port (gateway port + 2). */
const DEFAULT_PORT = 18791;

/** Shape returned by clawdbot's GET /requests endpoint. */
interface BrowserRequestEntry {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
  headers?: Record<string, string>;         // Available after install.sh patches clawdbot
  responseHeaders?: Record<string, string>;  // Available after install.sh patches clawdbot
}

/** Response from GET /requests. */
interface RequestsResponse {
  ok: boolean;
  targetId?: string;
  requests: BrowserRequestEntry[];
  error?: string;
}

/** Response from GET /cookies. */
interface CookiesResponse {
  ok: boolean;
  cookies?: { name: string; value: string; domain?: string; path?: string }[];
  error?: string;
}

/**
 * Fetch all captured network requests from clawdbot's browser control API.
 *
 * @param filter - Optional URL substring filter (e.g., "api" to only get API calls)
 * @param clear - Clear the request buffer after reading
 */
export async function fetchCapturedRequests(
  port = DEFAULT_PORT,
  filter?: string,
  clear = false,
): Promise<BrowserRequestEntry[]> {
  const url = new URL(`http://127.0.0.1:${port}/requests`);
  if (filter) url.searchParams.set("filter", filter);
  if (clear) url.searchParams.set("clear", "true");

  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Browser /requests failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as RequestsResponse;

  if (!data.ok && data.error) {
    throw new Error(data.error);
  }

  return data.requests ?? [];
}

/**
 * Fetch response body for a specific request ID.
 */
export async function fetchResponseBody(requestId: string, port = DEFAULT_PORT): Promise<string | null> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/response/body`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { body?: string };
    return data.body ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch all cookies from the browser session.
 */
export async function fetchBrowserCookies(port = DEFAULT_PORT): Promise<Record<string, string>> {
  const resp = await fetch(`http://127.0.0.1:${port}/cookies`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Browser /cookies failed (${resp.status}): ${text}`);
  }

  const data = await resp.json() as CookiesResponse;

  if (!data.ok && data.error) {
    throw new Error(data.error);
  }

  const cookies: Record<string, string> = {};
  for (const c of data.cookies ?? []) {
    cookies[c.name] = c.value;
  }
  return cookies;
}

/**
 * Convert clawdbot browser request entries to HAR format for pipeline reuse.
 *
 * After install.sh patches clawdbot, request and response headers are
 * included in the /requests endpoint. Without the patch, headers are empty
 * and auth is extracted from cookies instead.
 */
export function requestsToHar(entries: BrowserRequestEntry[]): { log: { entries: HarEntry[] } } {
  const harEntries: HarEntry[] = entries.map((entry) => {
    // Convert Record<string,string> headers to HAR name/value pairs
    const reqHeaders = entry.headers
      ? Object.entries(entry.headers).map(([name, value]) => ({ name, value }))
      : [];
    const respHeaders = entry.responseHeaders
      ? Object.entries(entry.responseHeaders).map(([name, value]) => ({ name, value }))
      : [];

    return {
      request: {
        method: entry.method,
        url: entry.url,
        headers: reqHeaders,
        cookies: [],
      },
      response: {
        status: entry.status ?? 0,
        headers: respHeaders,
      },
      time: entry.timestamp ? new Date(entry.timestamp).getTime() : undefined,
    };
  });

  return { log: { entries: harEntries } };
}

/**
 * Capture network traffic + cookies from a running browser session
 * and convert to HAR format for the parser pipeline.
 *
 * Requires a browser session started via clawdbot's browser tool
 * (e.g., `browser action=start profile=clawd targetUrl=...`).
 */
export async function captureFromBrowser(port = DEFAULT_PORT): Promise<{
  har: { log: { entries: HarEntry[] } };
  cookies: Record<string, string>;
  requestCount: number;
}> {
  const [entries, cookies] = await Promise.all([
    fetchCapturedRequests(port),
    fetchBrowserCookies(port),
  ]);

  const har = requestsToHar(entries);

  // Inject cookies into every HAR entry so the parser picks them up as auth
  const cookieArray = Object.entries(cookies).map(([name, value]) => ({ name, value }));
  for (const entry of har.log.entries) {
    entry.request.cookies = cookieArray;
  }

  return {
    har,
    cookies,
    requestCount: entries.length,
  };
}
