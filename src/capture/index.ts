import { BrowserManager } from "agent-browser/dist/browser.js";
import { executeCommand } from "agent-browser/dist/actions.js";
import { nanoid } from "nanoid";
import { getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";

// BUG-GC-012: Use a real Chrome UA — HeadlessChrome is actively blocked by Google and others.
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Browser launch semaphore: max 3 concurrent browsers
const MAX_CONCURRENT_BROWSERS = 3;
let activeBrowsers = 0;
const waitQueue: Array<() => void> = [];

// Active browser registry — tracked for graceful shutdown
const activeBrowserRegistry = new Set<InstanceType<typeof BrowserManager>>();

// Hard timeout per capture: 90s prevents stuck browsers from holding slots forever
const CAPTURE_TIMEOUT_MS = 90_000;

async function acquireBrowserSlot(): Promise<void> {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++;
    return;
  }
  return new Promise<void>((resolve) => {
    waitQueue.push(() => { activeBrowsers++; resolve(); });
  });
}

function releaseBrowserSlot(browser?: InstanceType<typeof BrowserManager>): void {
  if (browser) activeBrowserRegistry.delete(browser);
  activeBrowsers--;
  const next = waitQueue.shift();
  if (next) next();
}

/** Close all active browser instances — called on server shutdown. */
export async function shutdownAllBrowsers(): Promise<void> {
  await Promise.allSettled([...activeBrowserRegistry].map((b) => b.close()));
  activeBrowserRegistry.clear();
}

export interface CapturedWsMessage {
  url: string;
  direction: "sent" | "received";
  data: string;
  timestamp: string;
}

export interface CaptureResult {
  requests: RawRequest[];
  har_lineage_id: string;
  domain: string;
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; httpOnly?: boolean; secure?: boolean }>;
  final_url: string;
  ws_messages?: CapturedWsMessage[];
  html?: string;
}

export interface RawRequest {
  url: string;
  method: string;
  request_headers: Record<string, string>;
  request_body?: string;
  response_status: number;
  response_headers: Record<string, string>;
  response_body?: string;
  timestamp: string;
}

/**
 * Extract a route hint keyword from a URL path for intent-aware API waiting.
 * e.g., "/i/bookmarks" → "bookmark", "/dashboard/analytics" → "analytic"
 * Returns null if the path is too generic (root, single char, common SPA prefixes).
 */
function extractRouteHint(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    // Walk path segments from the end — the last meaningful segment is most specific
    const segments = pathname.split("/").filter(Boolean);
    // Skip generic SPA prefixes
    const GENERIC = /^(i|app|dashboard|page|view|en|es|fr|de|#|_|index|home|main)$/i;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg.length <= 2 || GENERIC.test(seg)) continue;
      // Return lowercased stem (strip trailing 's' for simple plural handling)
      return seg.toLowerCase().replace(/s$/, "");
    }
  } catch { /* bad URL */ }
  return null;
}

/**
 * Adaptive content-ready wait. Replaces flat 5s timeout.
 * Phase 1: 2s initial settle
 * Phase 2: If Cloudflare challenge detected, poll up to 15s for clearance
 * Phase 3: Wait for network idle (SPA API calls to complete)
 * Phase 4: Intent-aware API wait — if a route hint exists, wait for a matching API response
 * Worst case: 2 + 15 + 8 + 5 = 30s, well within CAPTURE_TIMEOUT_MS (90s).
 */
async function waitForContentReady(
  browser: InstanceType<typeof BrowserManager>,
  captureUrl?: string,
  capturedUrls?: Set<string>,
): Promise<void> {
  // Phase 1: Initial settle — let the page start rendering
  await new Promise((r) => setTimeout(r, 2000));

  // Phase 2: Cloudflare challenge detection and wait
  try {
    const page = browser.getPage();
    const hasCfChallenge = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      return (
        html.includes("challenge-platform") ||
        html.includes("cf_chl_opt") ||
        document.title === "Just a moment..." ||
        !!document.querySelector("#challenge-running, #challenge-form, .cf-browser-verification")
      );
    });

    if (hasCfChallenge) {
      log("capture", "Cloudflare challenge detected, waiting for clearance...");
      const CF_POLL_INTERVAL = 1500;
      const CF_MAX_WAIT = 15000;
      const cfStart = Date.now();

      while (Date.now() - cfStart < CF_MAX_WAIT) {
        await new Promise((r) => setTimeout(r, CF_POLL_INTERVAL));
        const stillBlocked = await page.evaluate(() => {
          return (
            document.title === "Just a moment..." ||
            !!document.querySelector("#challenge-running, #challenge-form, .cf-browser-verification")
          );
        }).catch(() => false);

        if (!stillBlocked) {
          log("capture", `Cloudflare cleared after ${Date.now() - cfStart}ms`);
          break;
        }
      }
    }
  } catch {
    // Page not available — skip CF detection
  }

  // Phase 3: Wait for network idle (SPA API calls to settle)
  try {
    const page = browser.getPage();
    await page.waitForLoadState("networkidle", { timeout: 8000 });
  } catch {
    // networkidle timeout is non-fatal — some sites never fully idle
  }

  // Phase 4: Intent-aware API wait — catch SPA lazy-loaded route-specific APIs
  // SPAs like x.com fire route-specific GraphQL queries (e.g., Bookmarks) after
  // the initial homepage APIs. If we have a route hint, wait for a matching response.
  if (captureUrl && capturedUrls) {
    const hint = extractRouteHint(captureUrl);
    if (hint) {
      // Check if any already-captured URL contains the hint
      const alreadyHave = [...capturedUrls].some((u) => u.toLowerCase().includes(hint));
      if (!alreadyHave) {
        log("capture", `intent-aware wait: looking for API matching "${hint}" (from ${captureUrl})`);
        try {
          const page = browser.getPage();
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 15000);
            const handler = (response: { url(): string }) => {
              if (response.url().toLowerCase().includes(hint)) {
                log("capture", `intent-aware wait: matched ${response.url().substring(0, 120)}`);
                clearTimeout(timeout);
                page.off("response", handler);
                // Give the response body time to arrive
                setTimeout(resolve, 500);
              }
            };
            page.on("response", handler);
          });
        } catch {
          // Non-fatal — proceed with what we have
        }
      } else {
        log("capture", `intent-aware wait: already captured API matching "${hint}", skipping`);
      }
    }
  }
}

export async function captureSession(
  url: string,
  authHeaders?: Record<string, string>,
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }>
): Promise<CaptureResult> {
  await acquireBrowserSlot();
  const browser = new BrowserManager();
  activeBrowserRegistry.add(browser);
  let captureTimedOut = false;
  const timeoutHandle = setTimeout(async () => {
    captureTimedOut = true;
    await browser.close().catch(() => {});
  }, CAPTURE_TIMEOUT_MS);
  try {
  const domain = new URL(url).hostname;

  // Always ephemeral headless — cookies are injected by the caller (bird pattern).
  // Persistent profiles are only for interactiveLogin where the user is present.
  await browser.launch({ action: "launch", id: nanoid(), headless: true, userAgent: CHROME_UA });

  // Override Chromium's auto-set Client Hints headers — without this, Chromium 145+
  // sends sec-ch-ua: "HeadlessChrome" even when user-agent is spoofed to Chrome 131,
  // which is how LinkedIn/Google/Cloudflare detect headless browsers.
  const CLIENT_HINT_HEADERS: Record<string, string> = {
    "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
  };
  await browser.setExtraHeaders({ ...CLIENT_HINT_HEADERS, ...(authHeaders ?? {}) });
  if (cookies && cookies.length > 0) {
    await injectCookies(browser, cookies);
  }

  await browser.startHarRecording();
  browser.startRequestTracking();

  // Hook page.on('response') BEFORE navigation to capture all response bodies
  // including XHR/fetch calls made during initial page load
  const responseBodies = new Map<string, string>();
  const MAX_BODY_SIZE = 512 * 1024; // 512KB
  try {
    const page = browser.getPage();
    page.on("response", async (response) => {
      try {
        const ct = response.headers()["content-type"] ?? "";
        const respUrl = response.url();
        // Capture JSON, protobuf, and batch RPC responses (Google batchexecute etc.)
        const isDataResponse =
          ct.includes("application/json") ||
          ct.includes("+json") ||
          ct.includes("application/x-protobuf") ||
          ct.includes("text/plain") ||
          respUrl.includes("batchexecute") ||
          respUrl.includes("/api/");
        if (!isDataResponse) return;
        // Skip static assets
        if (/\.(js|css|woff2?|png|jpg|svg|ico)(\?|$)/.test(respUrl)) return;
        const body = await response.body();
        if (body.length > MAX_BODY_SIZE) return;
        responseBodies.set(respUrl, body.toString("utf8"));
      } catch {
        // Response body may be unavailable for redirects/aborted
      }
    });
  } catch {
    // page not available — skip body capture
  }

  // CDP-based WebSocket capture
  const wsMessages: CapturedWsMessage[] = [];
  const wsUrlMap = new Map<string, string>(); // requestId -> url
  try {
    const page = browser.getPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");

    cdp.on("Network.webSocketCreated", (params: { requestId: string; url: string }) => {
      wsUrlMap.set(params.requestId, params.url);
    });

    cdp.on("Network.webSocketFrameReceived", (params: { requestId: string; timestamp: number; response: { payloadData: string } }) => {
      wsMessages.push({
        url: wsUrlMap.get(params.requestId) ?? params.requestId,
        direction: "received",
        data: params.response.payloadData,
        timestamp: new Date(params.timestamp * 1000).toISOString(),
      });
    });

    cdp.on("Network.webSocketFrameSent", (params: { requestId: string; timestamp: number; response: { payloadData: string } }) => {
      wsMessages.push({
        url: wsUrlMap.get(params.requestId) ?? params.requestId,
        direction: "sent",
        data: params.response.payloadData,
        timestamp: new Date(params.timestamp * 1000).toISOString(),
      });
    });
  } catch {
    // CDP session unavailable — skip WS capture
  }

  await executeCommand({ action: "navigate", id: nanoid(), url }, browser);

  // Adaptive wait: handle Cloudflare challenges + SPA content loading + intent-aware API wait
  const capturedUrlKeys = new Set(responseBodies.keys());
  await waitForContentReady(browser, url, capturedUrlKeys);

  // BUG-008: Share Cloudflare clearance cookies across subdomains
  try {
    const context = browser.getContext();
    if (context) {
      const allCookies = await context.cookies();
      const cfCookies = allCookies.filter(
        (c) => c.name === "__cf_bm" || c.name === "cf_clearance" || c.name.startsWith("__cf")
      );
      if (cfCookies.length > 0) {
        const baseDomain = getRegistrableDomain(new URL(url).hostname);
        const subdomainCookies = cfCookies.map((c) => ({
          ...c,
          domain: `.${baseDomain}`,
        }));
        try {
          await context.addCookies(subdomainCookies);
        } catch { /* CF cookie sharing is best-effort */ }
      }
    }
  } catch { /* context unavailable */ }

  const trackedRequests = browser.getRequests();
  const har_lineage_id = nanoid();

  // Debug: log all captured request URLs and response body map keys
  log("capture", `tracked ${trackedRequests.length} requests, ${responseBodies.size} response bodies`);
  for (const [bodyUrl] of responseBodies) {
    log("capture", `response body captured: ${bodyUrl.substring(0, 150)}`);
  }

  let final_url = url;
  let html: string | undefined;
  try {
    const page = browser.getPage();
    final_url = page.url();
    html = await page.content();
  } catch {}

  const requests: RawRequest[] = trackedRequests.map((r) => ({
    url: r.url,
    method: r.method,
    request_headers: r.headers,
    response_status: 0,
    response_headers: {},
    response_body: responseBodies.get(r.url),
    timestamp: new Date(r.timestamp).toISOString(),
  }));

  // Synthesize RawRequests for response bodies captured by the response listener
  // but missed by request tracking (e.g., SPA API calls during intent-aware wait).
  const trackedUrls = new Set(trackedRequests.map((r) => r.url));
  for (const [bodyUrl, body] of responseBodies) {
    if (!trackedUrls.has(bodyUrl)) {
      requests.push({
        url: bodyUrl,
        method: "GET",
        request_headers: {},
        response_status: 200,
        response_headers: {},
        response_body: body,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Extract session cookies so callers can persist auth for future executions
  const ctx = browser.getContext();
  const rawCookies = ctx ? await ctx.cookies().catch(() => []) : [];
  const sessionCookies = rawCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    httpOnly: c.httpOnly,
    secure: c.secure,
  }));

  if (captureTimedOut) throw new Error(`captureSession timed out after ${CAPTURE_TIMEOUT_MS}ms for ${url}`);
  return { requests, har_lineage_id, domain, cookies: sessionCookies.length > 0 ? sessionCookies : undefined, final_url, ws_messages: wsMessages.length > 0 ? wsMessages : undefined, html };
  } finally {
    clearTimeout(timeoutHandle);
    releaseBrowserSlot(browser);
  }
}

export async function executeInBrowser(
  url: string,
  method: string,
  requestHeaders: Record<string, string>,
  body?: unknown,
  authHeaders?: Record<string, string>,
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }>
): Promise<{ status: number; data: unknown; trace_id: string }> {
  await acquireBrowserSlot();
  const browser = new BrowserManager();
  activeBrowserRegistry.add(browser);
  try {
  await browser.launch({ action: "launch", id: nanoid(), headless: true, userAgent: CHROME_UA });

  const allHeaders = { ...authHeaders, ...requestHeaders };
  if (Object.keys(allHeaders).length > 0) {
    await browser.setExtraHeaders(allHeaders);
  }
  if (cookies && cookies.length > 0) {
    await injectCookies(browser, cookies);
  }

  // No auth: use in-page fetch (original path)
  browser.startRequestTracking();
  const origin = new URL(url).origin;
  await executeCommand({ action: "navigate", id: nanoid(), url: origin }, browser);

  const page = browser.getPage();
  const result = await page.evaluate(
    async ({ url, method, headers, body }: { url: string; method: string; headers: Record<string, string>; body: unknown }) => {
      const res = await fetch(url, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    },
    { url, method, headers: requestHeaders, body }
  );

  return { ...result, trace_id: nanoid() };
  } finally {
    releaseBrowserSlot(browser);
  }
}

/**
 * Trigger-and-intercept execution: navigate to the page that originally
 * triggered an API call, let the site's own JS make the request (passing
 * CSRF checks, TLS fingerprinting, etc.), and intercept the response.
 *
 * This is the generalized version of bird's approach:
 * - Bird works because Twitter doesn't do TLS fingerprinting
 * - Sites like LinkedIn do, so we let their JS make the call
 * - The site's own code handles CSRF tokens, session state, etc.
 */
export async function triggerAndIntercept(
  triggerUrl: string,
  targetUrlPattern: string,
  cookies: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }>,
  authHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown; trace_id: string }> {
  await acquireBrowserSlot();
  const browser = new BrowserManager();
  activeBrowserRegistry.add(browser);
  try {
    await browser.launch({ action: "launch", id: nanoid(), headless: true, userAgent: CHROME_UA });

    // Set extra headers (client hints to avoid headless detection)
    const headers: Record<string, string> = {
      "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
      ...authHeaders,
    };
    await browser.setExtraHeaders(headers);
    await injectCookies(browser, cookies);

    const page = browser.getPage();

    // Build a URL matcher: strip template vars and match on the base path.
    // For graphql endpoints, preserve the queryId param so we match the specific query,
    // not just any /graphql call (e.g. voyagerFeedDashMainFeed vs voyagerMessagingDash...).
    const targetBase = targetUrlPattern.replace(/\{[^}]+\}/g, "").split("?")[0];
    // For graphql endpoints, extract the queryId name (before the hash) for matching.
    // e.g. "voyagerFeedDashMainFeed.923020905727c01..." → "voyagerFeedDashMainFeed"
    let targetQueryId: string | null = null;
    try {
      const tu = new URL(targetUrlPattern.replace(/\{[^}]+\}/g, "x"));
      const rawQueryId = tu.searchParams.get("queryId");
      // Strip hash suffix — keep only the semantic name for matching
      targetQueryId = rawQueryId ? rawQueryId.split(".")[0] : null;
    } catch { /* skip */ }

    // Set up response interception BEFORE navigation
    let captured: { status: number; data: unknown } | null = null;
    const interceptPromise = new Promise<{ status: number; data: unknown }>((resolve) => {
      const timeout = setTimeout(() => {
        resolve({ status: 0, data: { error: "trigger_timeout", message: "Target API call not intercepted within 15s" } });
      }, 15000);

      page.on("response", async (response) => {
        const respUrl = response.url();
        // Match if the response URL contains the target base path (and queryId if graphql)
        const baseMatch = respUrl.includes(targetBase);
        const queryIdMatch = !targetQueryId || respUrl.includes(targetQueryId);
        if (baseMatch && queryIdMatch && !captured) {
          captured = { status: response.status(), data: null };
          try {
            const body = await response.text();
            try { captured.data = JSON.parse(body); } catch { captured.data = body; }
          } catch {
            captured.data = null;
          }
          clearTimeout(timeout);
          resolve(captured);
        }
      });
    });

    // Navigate to the trigger page — the site's JS will make the API call.
    // Use domcontentloaded (not networkidle) — we only need the specific API call to fire,
    // not all network activity to settle. The interceptPromise resolves as soon as it's captured.
    log("capture", `trigger-and-intercept: navigating to ${triggerUrl}, waiting for ${targetBase}${targetQueryId ? `?queryId=${targetQueryId.slice(0, 40)}` : ""}`);
    page.goto(triggerUrl, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);

    const result = await interceptPromise;
    log("capture", `trigger-and-intercept: got status ${result.status} for ${targetBase}`);
    return { ...result, trace_id: nanoid() };
  } finally {
    releaseBrowserSlot(browser);
  }
}

/**
 * Sanitize and inject cookies into browser context.
 * Strips all fields except { name, value, domain, path } to avoid
 * Playwright CDP protocol errors from unexpected cookie properties.
 * Falls back to per-cookie injection if batch fails.
 */
async function injectCookies(
  browser: InstanceType<typeof BrowserManager>,
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
    expires?: number;
  }>
): Promise<void> {
  const context = browser.getContext();
  if (!context) return;

  const sanitized = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
    path: c.path ?? "/",
    ...(c.secure != null ? { secure: c.secure } : {}),
    ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
    ...(c.sameSite != null ? { sameSite: c.sameSite as "Strict" | "Lax" | "None" } : {}),
    ...(c.expires != null && c.expires > 0 ? { expires: c.expires } : {}),
  }));

  log("capture", `injecting ${sanitized.length} cookies for domains: ${[...new Set(sanitized.map((c) => c.domain))].join(", ")}`);
  try {
    await context.addCookies(sanitized);
  } catch (batchErr) {
    log("capture", `batch cookie injection failed: ${batchErr instanceof Error ? batchErr.message : batchErr} — falling back to per-cookie`);
    let injected = 0;
    for (const cookie of sanitized) {
      try {
        await context.addCookies([cookie]);
        injected++;
      } catch (err) {
        log("capture", `failed to inject cookie "${cookie.name}" for ${cookie.domain}: ${err instanceof Error ? err.message : err}`);
      }
    }
    log("capture", `per-cookie fallback: ${injected}/${sanitized.length} injected`);
  }
}
