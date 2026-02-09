/**
 * CDP Capture — Live network capture via OpenClaw's browser control API.
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

/** Active WebSocket for CDP header capture (if connected). */
let cdpWs: any | null = null;

/** In-flight start promise to avoid concurrent connections. */
let cdpStartPromise: Promise<boolean> | null = null;

/** Shape returned by OpenClaw's GET /requests endpoint. */
interface BrowserRequestEntry {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
  headers?: Record<string, string>;         // Available after install.sh patches openclaw
  responseHeaders?: Record<string, string>;  // Available after install.sh patches openclaw
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
 * Fetch all captured network requests from OpenClaw's browser control API.
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
 * Convert OpenClaw browser request entries to HAR format for pipeline reuse.
 *
 * After install.sh patches openclaw, request and response headers are
 * included in the /requests endpoint. Without the patch, headers are empty
 * and we try to enrich from CDP header cache, falling back to cookies.
 */
/** Filter out HTTP/2 pseudo-headers that break when replayed as regular headers. */
function filterPseudoHeaders(headers: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    // Skip HTTP/2 pseudo-headers (start with :)
    if (key.startsWith(":")) continue;
    filtered[key] = value;
  }
  return filtered;
}

export function requestsToHar(entries: BrowserRequestEntry[]): { log: { entries: HarEntry[] } } {
  const harEntries: HarEntry[] = entries.map((entry) => {
    // Convert Record<string,string> headers to HAR name/value pairs
    // Filter out HTTP/2 pseudo-headers (:authority, :method, :path, :scheme)
    // These break when replayed as regular headers
    let reqHeaders: Array<{ name: string; value: string }> = [];
    if (entry.headers && Object.keys(entry.headers).length > 0) {
      const filtered = filterPseudoHeaders(entry.headers);
      reqHeaders = Object.entries(filtered).map(([name, value]) => ({ name, value }));
    } else {
      // Try CDP header cache
      const cached = headerCache.get(entry.url);
      if (cached) {
        const filtered = filterPseudoHeaders(cached);
        reqHeaders = Object.entries(filtered).map(([name, value]) => ({ name, value }));
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
  if (cdpStartPromise) return cdpStartPromise;

  cdpStartPromise = (async () => {
    try {
      // Check if Chrome has remote debugging enabled.
      const resp = await fetch(`http://127.0.0.1:${chromePort}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!resp.ok) return false;

      const data = await resp.json() as { webSocketDebuggerUrl?: string };
      const wsUrl = data.webSocketDebuggerUrl;
      if (!wsUrl) return false;

      // Connect via WebSocket and listen for Network events.
      // Use `createConnection` to `unref()` the socket immediately so a stuck
      // connection attempt never prevents short-lived CLI commands from exiting.
      const WebSocket = (await import("ws")).default as any;
      const net = await import("node:net");
      const tls = await import("node:tls");

      let msgId = 1;
      const ws: any = new WebSocket(wsUrl, {
        handshakeTimeout: 2000,
        perMessageDeflate: false,
        createConnection: (opts: any) => {
          const protocol = String(opts?.protocol ?? "");
          const isTls = protocol === "https:" || protocol === "wss:";
          const socket = isTls ? (tls as any).connect(opts) : (net as any).connect(opts);
          socket.unref?.();
          return socket;
        },
      });
      cdpWs = ws;

      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (ok: boolean) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };

        const connectTimeout = setTimeout(() => {
          // Best-effort: ensure a hung connect doesn't leave dangling handles.
          try { ws.terminate?.(); } catch { /* ignore */ }
          try { ws.close?.(); } catch { /* ignore */ }
          if (cdpWs === ws) cdpWs = null;
          cdpListenerActive = false;
          settle(false);
        }, 2500);
        connectTimeout.unref?.(); // Don't keep process alive for handshake timeout

        ws.on("open", () => {
          // Enable network domain
          try {
            ws.send(JSON.stringify({ id: msgId++, method: "Network.enable" }));
          } catch { /* ignore */ }

          cdpListenerActive = true;

          // Extra safety for older ws versions that expose the raw socket.
          try { ws._socket?.unref?.(); } catch { /* ignore */ }

          clearTimeout(connectTimeout);
          settle(true);
        });

        ws.on("message", (data: any) => {
          try {
            const text = Buffer.isBuffer(data) ? data.toString() : String(data);
            const msg = JSON.parse(text);

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
              const resp2 = msg.params?.response;
              if (resp2?.url && resp2?.headers) {
                responseHeaderCache.set(resp2.url, resp2.headers);
                if (responseHeaderCache.size > 1000) {
                  const firstKey = responseHeaderCache.keys().next().value;
                  if (firstKey) responseHeaderCache.delete(firstKey);
                }
              }
            }
          } catch { /* ignore parse errors */ }
        });

        const onCloseOrError = () => {
          cdpListenerActive = false;
          if (cdpWs === ws) cdpWs = null;
          if (!settled) {
            clearTimeout(connectTimeout);
            settle(false);
          }
        };
        ws.on("close", onCloseOrError);
        ws.on("error", onCloseOrError);
      });
    } catch {
      return false;
    } finally {
      cdpStartPromise = null;
    }
  })();

  return cdpStartPromise;
}

/**
 * Stop the CDP header listener (best-effort).
 * This is used to avoid leaking long-lived sockets across short-lived CLI commands.
 */
export function stopCdpHeaderListener(): void {
  const ws: any = cdpWs;
  cdpWs = null;
  cdpListenerActive = false;
  try { ws?.terminate?.(); } catch { /* ignore */ }
  try { ws?.close?.(); } catch { /* ignore */ }
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
 * Requires a browser session started via OpenClaw's browser tool
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
