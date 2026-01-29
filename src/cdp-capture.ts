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

/** Cache of headers captured via CDP (url -> headers). */
const headerCache = new Map<string, Record<string, string>>();
const responseHeaderCache = new Map<string, Record<string, string>>();

/** Whether CDP header listener is active. */
let cdpListenerActive = false;

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
 * and we try to enrich from CDP header cache, falling back to cookies.
 */
export function requestsToHar(entries: BrowserRequestEntry[]): { log: { entries: HarEntry[] } } {
  const harEntries: HarEntry[] = entries.map((entry) => {
    // Convert Record<string,string> headers to HAR name/value pairs
    // First try entry.headers, then fall back to CDP cache
    let reqHeaders: Array<{ name: string; value: string }> = [];
    if (entry.headers && Object.keys(entry.headers).length > 0) {
      reqHeaders = Object.entries(entry.headers).map(([name, value]) => ({ name, value }));
    } else {
      // Try CDP header cache
      const cached = headerCache.get(entry.url);
      if (cached) {
        reqHeaders = Object.entries(cached).map(([name, value]) => ({ name, value }));
      }
    }

    let respHeaders: Array<{ name: string; value: string }> = [];
    if (entry.responseHeaders && Object.keys(entry.responseHeaders).length > 0) {
      respHeaders = Object.entries(entry.responseHeaders).map(([name, value]) => ({ name, value }));
    } else {
      // Try CDP response header cache
      const cached = responseHeaderCache.get(entry.url);
      if (cached) {
        respHeaders = Object.entries(cached).map(([name, value]) => ({ name, value }));
      }
    }

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
 * Start CDP header listener to capture headers in real-time.
 * Connects to Chrome's remote debugging port if available.
 * Headers are cached and used to enrich /requests data.
 */
export async function startCdpHeaderListener(chromePort = 9222): Promise<boolean> {
  if (cdpListenerActive) return true;

  try {
    // Check if Chrome has remote debugging enabled
    const resp = await fetch(`http://127.0.0.1:${chromePort}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;

    const data = await resp.json() as { webSocketDebuggerUrl?: string };
    const wsUrl = data.webSocketDebuggerUrl;
    if (!wsUrl) return false;

    // Connect via WebSocket and listen for Network events
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(wsUrl);

    let msgId = 1;

    ws.on("open", () => {
      // Enable network domain
      ws.send(JSON.stringify({ id: msgId++, method: "Network.enable" }));
      cdpListenerActive = true;
    });

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());

        // Cache request headers
        if (msg.method === "Network.requestWillBeSent") {
          const req = msg.params?.request;
          if (req?.url && req?.headers) {
            headerCache.set(req.url, req.headers);
            // Keep cache bounded
            if (headerCache.size > 1000) {
              const firstKey = headerCache.keys().next().value;
              if (firstKey) headerCache.delete(firstKey);
            }
          }
        }

        // Cache response headers
        if (msg.method === "Network.responseReceived") {
          const resp = msg.params?.response;
          if (resp?.url && resp?.headers) {
            responseHeaderCache.set(resp.url, resp.headers);
            if (responseHeaderCache.size > 1000) {
              const firstKey = responseHeaderCache.keys().next().value;
              if (firstKey) responseHeaderCache.delete(firstKey);
            }
          }
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on("close", () => {
      cdpListenerActive = false;
    });

    ws.on("error", () => {
      cdpListenerActive = false;
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Get cached headers for a URL (if CDP listener captured them).
 */
export function getCachedHeaders(url: string): Record<string, string> | undefined {
  return headerCache.get(url);
}

/**
 * Get cached response headers for a URL.
 */
export function getCachedResponseHeaders(url: string): Record<string, string> | undefined {
  return responseHeaderCache.get(url);
}

/**
 * Capture network traffic + cookies from a running browser session
 * and convert to HAR format for the parser pipeline.
 *
 * Requires a browser session started via clawdbot's browser tool
 * (e.g., `browser action=start profile=clawd targetUrl=...`).
 *
 * If headers are missing from the /requests endpoint, tries to
 * enrich them from the CDP header cache.
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
