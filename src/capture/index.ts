import * as kuri from "../kuri/client.js";
import { nanoid } from "nanoid";
import { getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";

// BUG-GC-012: Use a real Chrome UA — HeadlessChrome is actively blocked by Google and others.
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Tab semaphore: max 3 concurrent capture tabs
const MAX_CONCURRENT_TABS = 3;
let activeTabs = 0;
const waitQueue: Array<() => void> = [];

// Active tab registry — tracked for graceful shutdown
const activeTabRegistry = new Set<string>();

// Hard timeout per capture: 90s prevents stuck tabs from holding slots forever
const CAPTURE_TIMEOUT_MS = 90_000;
const CAPTURE_NAV_TIMEOUT_MS = 20_000;

// Client hint headers to avoid headless detection
const CLIENT_HINT_HEADERS: Record<string, string> = {
  "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
};

async function resetTab(tabId: string): Promise<void> {
  try {
    await kuri.navigate(tabId, "about:blank");
  } catch { /* best-effort */ }
}

type CaptureNavigationPage = {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
};

export async function navigatePageForCapture(page: CaptureNavigationPage, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: CAPTURE_NAV_TIMEOUT_MS });
}

async function acquireTabSlot(): Promise<void> {
  if (activeTabs < MAX_CONCURRENT_TABS) {
    activeTabs++;
    return;
  }
  return new Promise<void>((resolve) => {
    waitQueue.push(() => { activeTabs++; resolve(); });
  });
}

function releaseTabSlot(tabId?: string): void {
  if (tabId) activeTabRegistry.delete(tabId);
  activeTabs--;
  const next = waitQueue.shift();
  if (next) next();
}

/** Close all active tabs — called on server shutdown. */
export async function shutdownAllBrowsers(): Promise<void> {
  await Promise.allSettled([...activeTabRegistry].map((t) => resetTab(t)));
  activeTabRegistry.clear();
  await kuri.stop();
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
  js_bundles?: Map<string, string>;
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

export type CapturedCookie = {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
};

export function filterFirstPartySessionCookies(
  cookies: CapturedCookie[],
  ...urls: Array<string | undefined>
): CapturedCookie[] {
  const hosts = new Set<string>();
  const domains = new Set<string>();
  for (const rawUrl of urls) {
    if (!rawUrl) continue;
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      hosts.add(host);
      domains.add(getRegistrableDomain(host));
    } catch {
      // ignore bad urls
    }
  }
  if (hosts.size === 0 && domains.size === 0) return cookies;
  return cookies.filter((cookie) => {
    const cookieDomain = cookie.domain.replace(/^\./, "").toLowerCase();
    if (!cookieDomain) return false;
    if (hosts.has(cookieDomain)) return true;
    try {
      return domains.has(getRegistrableDomain(cookieDomain));
    } catch {
      return false;
    }
  });
}

export function isBlockedAppShell(html?: string): boolean {
  if (!html) return false;
  return (
    /JavaScript is not available\./i.test(html) ||
    /switch to a supported browser/i.test(html) ||
    /Something went wrong, but don.?t fret/i.test(html) ||
    /class=["']errorContainer["']/i.test(html) ||
    /#placeholder,\s*#react-root\s*\{\s*display:\s*none/i.test(html)
  );
}

function shouldRetryEphemeralProfileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /persistentcontext|target page, context or browser has been closed|browser has been closed|page has been closed/i.test(message);
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
    const GENERIC = /^(i|app|dashboard|page|view|en|es|fr|de|#|_|index|home|main|me|@me|users?|channels?|guilds?|servers?|messages?|threads?|conversations?)$/i;
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (seg.length <= 2 || GENERIC.test(seg) || /^\d+$/.test(seg) || /^\{.+\}$/.test(seg) || /^[0-9a-f-]{8,}$/i.test(seg)) continue;
      // Return lowercased stem (strip trailing 's' for simple plural handling)
      return seg.toLowerCase().replace(/s$/, "");
    }
  } catch { /* bad URL */ }
  return null;
}

function deriveIntentHints(captureUrl?: string, intent?: string): string[] {
  const derivedHints = new Set<string>();
  if (captureUrl) {
    const routeHint = extractRouteHint(captureUrl);
    if (routeHint) derivedHints.add(routeHint);
  }
  const lowerIntent = intent?.toLowerCase() ?? "";
  if (/\b(person|people|profile|profiles|user|users|member|members)\b/.test(lowerIntent)) {
    derivedHints.add("profile");
    derivedHints.add("users");
    derivedHints.add("userby");
  }
  if (/\b(company|companies|organization|organisations|business)\b/.test(lowerIntent)) {
    derivedHints.add("company");
    derivedHints.add("organization");
    derivedHints.add("about");
  }
  if (/\b(post|posts|tweet|tweets|status|statuses)\b/.test(lowerIntent)) {
    derivedHints.add("tweet");
    derivedHints.add("timeline");
    derivedHints.add("status");
  }
  if (/\b(guild|guilds|server|servers)\b/.test(lowerIntent)) {
    derivedHints.add("guild");
    derivedHints.add("guilds");
  }
  if (/\b(channel|channels)\b/.test(lowerIntent)) {
    derivedHints.add("channel");
    derivedHints.add("channels");
  }
  if (/\b(message|messages|dm|dms|chat|thread|threads|conversation|conversations)\b/.test(lowerIntent)) {
    derivedHints.add("message");
    derivedHints.add("messages");
    derivedHints.add("thread");
    derivedHints.add("threads");
  }
  if (/\b(topic|topics|trend|trending|hashtag|hashtags)\b/.test(lowerIntent)) {
    derivedHints.add("trend");
    derivedHints.add("explore");
    derivedHints.add("topic");
  }
  return [...derivedHints];
}

function hasCapturedHint(responseUrls: Iterable<string>, hint: string): boolean {
  const lowerHint = hint.toLowerCase();
  for (const url of responseUrls) {
    if (url.toLowerCase().includes(lowerHint)) return true;
  }
  return false;
}

async function maybeProbeIntentApis(
  tabId: string,
  captureUrl: string | undefined,
  intent: string | undefined,
  responseBodies: Map<string, string> | undefined,
): Promise<void> {
  if (!captureUrl || !responseBodies) return;
  const lowerIntent = intent?.toLowerCase() ?? "";
  let hostname = "";
  try {
    hostname = new URL(captureUrl).hostname.toLowerCase();
  } catch {
    return;
  }

  if (/discord\.com$/.test(hostname) && /\b(guild|guilds|server|servers)\b/.test(lowerIntent)) {
    if (hasCapturedHint(responseBodies.keys(), "/guild")) return;
    const probes = [
      { label: "User affinities guilds", path: "/api/v9/users/@me/affinities/guilds" },
      { label: "User guilds", path: "/api/v9/users/@me/guilds?with_counts=true" },
    ];
    try {
      for (const probe of probes) {
        if (hasCapturedHint(responseBodies.keys(), "/guild")) break;
        log("spa", `probing ${probe.label}: GET https://discord.com${probe.path}`);
        await kuri.evaluate(tabId, `(async function() {
          try {
            var response = await fetch(${JSON.stringify(probe.path)}, { credentials: "include" });
            await response.text();
          } catch(e) { /* best-effort probe */ }
        })()`);
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch {
      // non-fatal
    }
  }
}

const CAPTURE_RESPONSE_NOISE = /user_flow|datasavermode|ces\/p2|intercom|badge_count|settings\.json|paymentfailure|saved_searches|launcher_settings|conversations|\/ping\b|verifiedorg|xchatdmsettings|scheduledpromotions|storytopic|sidebaruserrecommendations|subscriptions|live_pipeline|fleetline|authorizetoken|logintwittertoken/i;

export function hasUsefulCapturedResponses(
  responseUrls: Iterable<string>,
  captureUrl?: string,
  intent?: string,
): boolean {
  const usefulUrls = [...responseUrls].filter((url) => !CAPTURE_RESPONSE_NOISE.test(url));
  if (usefulUrls.length === 0) return false;
  const hints = deriveIntentHints(captureUrl, intent);
  if (hints.length === 0) return usefulUrls.length > 0;
  return usefulUrls.some((url) => {
    const lower = url.toLowerCase();
    return hints.some((hint) => lower.includes(hint));
  });
}

/**
 * Inject a fetch/XHR interceptor into the page to capture request/response data.
 * Returns captured entries via __unbrowse_intercepted global.
 */
const INTERCEPTOR_SCRIPT = `(function() {
  if (window.__unbrowse_interceptor_installed) return;
  window.__unbrowse_interceptor_installed = true;
  window.__unbrowse_intercepted = [];
  var MAX_BODY = 512 * 1024;
  var MAX_JS_BODY = 2 * 1024 * 1024;
  var MAX_ENTRIES = 500;

  // Intercept fetch
  var origFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
    var opts = args[1] || {};
    var method = (opts.method || 'GET').toUpperCase();
    var reqBody = opts.body ? String(opts.body).substring(0, MAX_BODY) : undefined;
    var reqHeaders = {};
    if (opts.headers) {
      if (typeof opts.headers.forEach === 'function') {
        opts.headers.forEach(function(v, k) { reqHeaders[k] = v; });
      } else {
        Object.keys(opts.headers).forEach(function(k) { reqHeaders[k] = opts.headers[k]; });
      }
    }
    return origFetch.apply(this, args).then(function(response) {
      if (window.__unbrowse_intercepted.length >= MAX_ENTRIES) return response;
      var ct = response.headers.get('content-type') || '';
      var isJs = ct.indexOf('javascript') !== -1 || /\\.js(\\?|$)/.test(url);
      var isData = ct.indexOf('application/json') !== -1 || ct.indexOf('+json') !== -1 ||
                   ct.indexOf('application/x-protobuf') !== -1 || ct.indexOf('text/plain') !== -1 ||
                   url.indexOf('batchexecute') !== -1 || url.indexOf('/api/') !== -1;
      if (!isJs && !isData) return response;
      if (/\\.(css|woff2?|png|jpg|svg|ico)(\\?|$)/.test(url)) return response;
      var clone = response.clone();
      clone.text().then(function(body) {
        var limit = isJs ? MAX_JS_BODY : MAX_BODY;
        if (body.length > limit) return;
        var respHeaders = {};
        response.headers.forEach(function(v, k) { respHeaders[k] = v; });
        window.__unbrowse_intercepted.push({
          url: url,
          method: method,
          request_headers: reqHeaders,
          request_body: reqBody,
          response_status: response.status,
          response_headers: respHeaders,
          response_body: body,
          content_type: ct,
          is_js: isJs,
          timestamp: new Date().toISOString()
        });
      }).catch(function() {});
      return response;
    }).catch(function(err) { throw err; });
  };

  // Intercept XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__unbrowse_method = method;
    this.__unbrowse_url = url;
    this.__unbrowse_reqHeaders = {};
    var origSetHeader = this.setRequestHeader.bind(this);
    this.setRequestHeader = function(k, v) {
      this.__unbrowse_reqHeaders[k] = v;
      origSetHeader(k, v);
    }.bind(this);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    xhr.addEventListener('load', function() {
      if (window.__unbrowse_intercepted.length >= MAX_ENTRIES) return;
      var ct = xhr.getResponseHeader('content-type') || '';
      var url = xhr.__unbrowse_url || '';
      var isJs = ct.indexOf('javascript') !== -1 || /\\.js(\\?|$)/.test(url);
      var isData = ct.indexOf('application/json') !== -1 || ct.indexOf('+json') !== -1 ||
                   ct.indexOf('application/x-protobuf') !== -1 || ct.indexOf('text/plain') !== -1 ||
                   url.indexOf('batchexecute') !== -1 || url.indexOf('/api/') !== -1;
      if (!isJs && !isData) return;
      if (/\\.(css|woff2?|png|jpg|svg|ico)(\\?|$)/.test(url)) return;
      var respBody = xhr.responseText || '';
      var limit = isJs ? MAX_JS_BODY : MAX_BODY;
      if (respBody.length > limit) return;
      window.__unbrowse_intercepted.push({
        url: url,
        method: (xhr.__unbrowse_method || 'GET').toUpperCase(),
        request_headers: xhr.__unbrowse_reqHeaders || {},
        request_body: body ? String(body).substring(0, MAX_BODY) : undefined,
        response_status: xhr.status,
        response_headers: {},
        response_body: respBody,
        content_type: ct,
        is_js: isJs,
        timestamp: new Date().toISOString()
      });
    });
    return origSend.apply(this, arguments);
  };
})()`;

/**
 * Collect intercepted requests from the page.
 */
async function collectInterceptedRequests(tabId: string): Promise<Array<{
  url: string;
  method: string;
  request_headers: Record<string, string>;
  request_body?: string;
  response_status: number;
  response_headers: Record<string, string>;
  response_body?: string;
  content_type?: string;
  is_js?: boolean;
  timestamp: string;
}>> {
  try {
    const result = await kuri.evaluate(tabId, "JSON.stringify(window.__unbrowse_intercepted || [])");
    if (typeof result === "string" && result.startsWith("[")) {
      return JSON.parse(result);
    }
  } catch { /* non-fatal */ }
  return [];
}

/**
 * Poll document.readyState until "complete" or timeout.
 * Replaces page.waitForLoadState("networkidle").
 */
async function waitForReadyState(tabId: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = await kuri.evaluate(tabId, "document.readyState");
      if (state === "complete") return;
    } catch { /* tab may not be ready */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Adaptive content-ready wait. Replaces flat 5s timeout.
 * Phase 1: 2s initial settle
 * Phase 2: If Cloudflare challenge detected, poll up to 15s for clearance
 * Phase 3: Wait for document.readyState complete (replaces networkidle)
 * Phase 4: Intent-aware API wait — poll intercepted requests for matching URLs
 * Phase 5: SPA scroll stimulus for search/explore pages
 */
async function waitForContentReady(
  tabId: string,
  captureUrl?: string,
  intent?: string,
  responseBodies?: Map<string, string>,
): Promise<void> {
  // Phase 1: Initial settle — let the page start rendering
  await new Promise((r) => setTimeout(r, 2000));

  // Phase 2: Cloudflare challenge detection and wait
  try {
    const hasCf = await kuri.hasCloudflareChallenge(tabId);
    if (hasCf) {
      log("capture", "Cloudflare challenge detected, waiting for clearance...");
      const cleared = await kuri.waitForCloudflare(tabId, 15000);
      if (cleared) {
        log("capture", "Cloudflare cleared");
      }
    }
  } catch {
    // Tab not available — skip CF detection
  }

  // Phase 3: Wait for document ready state (replaces networkidle)
  await waitForReadyState(tabId, 8000);

  // Phase 4: Intent-aware API wait — poll intercepted requests for matching API URLs
  if (captureUrl && responseBodies) {
    const derivedHints = new Set(deriveIntentHints(captureUrl, intent));
    const wantedHints = [...derivedHints].filter((hint) =>
      ![...responseBodies.keys()].some((u) => u.toLowerCase().includes(hint))
    );
    if (wantedHints.length > 0) {
      log("capture", `intent-aware wait: looking for API matching one of [${wantedHints.join(", ")}] (from ${captureUrl})`);
      const intentStart = Date.now();
      const INTENT_MAX_WAIT = 15000;
      const INTENT_POLL_INTERVAL = 1500;
      while (Date.now() - intentStart < INTENT_MAX_WAIT) {
        await new Promise((r) => setTimeout(r, INTENT_POLL_INTERVAL));
        // Check newly intercepted requests
        const intercepted = await collectInterceptedRequests(tabId);
        for (const entry of intercepted) {
          const respUrl = entry.url.toLowerCase();
          const matchedHint = wantedHints.find((hint) => respUrl.includes(hint));
          if (matchedHint) {
            log("capture", `intent-aware wait: matched ${matchedHint} via ${entry.url.substring(0, 120)}`);
            // Add to responseBodies so downstream sees it
            if (entry.response_body && !entry.is_js) {
              responseBodies.set(entry.url, entry.response_body);
            }
            await new Promise((r) => setTimeout(r, 500));
            return;
          }
        }
      }
    } else if (derivedHints.size > 0) {
      log("capture", `intent-aware wait: already captured API matching one of [${[...derivedHints].join(", ")}], skipping`);
    }
  }

  // Phase 5: generic SPA stimulus via scroll
  const lowerIntent = intent?.toLowerCase() ?? "";
  if (
    captureUrl &&
    responseBodies &&
    (
      /search|explore|trending|tabs|discover/i.test(captureUrl) ||
      /\b(person|people|profile|profiles|user|users|member|members|company|companies|organization|organisations|business|post|posts|tweet|tweets|status|statuses)\b/.test(lowerIntent)
    )
  ) {
    try {
      const before = responseBodies.size;
      await kuri.evaluate(tabId, "window.scrollTo(0, Math.max(window.innerHeight, Math.min(document.body.scrollHeight, window.innerHeight * 2)))");
      await new Promise((r) => setTimeout(r, 1200));
      await kuri.evaluate(tabId, "window.scrollTo(0, 0)");
      if (responseBodies.size === before) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch {
      // non-fatal
    }
  }

  await maybeProbeIntentApis(tabId, captureUrl, intent, responseBodies);
}

/**
 * Inject cookies into tab via kuri.setCookies.
 */
async function injectCookies(
  tabId: string,
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
  const sanitized = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith(".") ? c.domain : `.${c.domain}`,
    path: c.path ?? "/",
    ...(c.secure != null ? { secure: c.secure } : {}),
    ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
    ...(c.sameSite != null ? { sameSite: c.sameSite } : {}),
    ...(c.expires != null && c.expires > 0 ? { expires: c.expires } : {}),
  }));

  log("capture", `injecting ${sanitized.length} cookies for domains: ${[...new Set(sanitized.map((c) => c.domain))].join(", ")}`);
  try {
    await kuri.setCookies(tabId, sanitized);
  } catch (batchErr) {
    log("capture", `batch cookie injection failed: ${batchErr instanceof Error ? batchErr.message : batchErr} — falling back to per-cookie`);
    let injected = 0;
    for (const cookie of sanitized) {
      try {
        await kuri.setCookie(tabId, cookie);
        injected++;
      } catch (err) {
        log("capture", `failed to inject cookie "${cookie.name}" for ${cookie.domain}: ${err instanceof Error ? err.message : err}`);
      }
    }
    log("capture", `per-cookie fallback: ${injected}/${sanitized.length} injected`);
  }
}

/**
 * Extract cookies from page via document.cookie (CDP getCookies crashes Kuri).
 * Parses simple name=value pairs — httpOnly cookies are NOT visible via JS.
 */
async function extractCookiesFromPage(tabId: string, pageUrl: string): Promise<CapturedCookie[]> {
  try {
    const raw = await kuri.evaluate(tabId, "document.cookie");
    if (typeof raw !== "string" || !raw) return [];
    let hostname = "";
    try { hostname = new URL(pageUrl).hostname; } catch { return []; }
    const domain = hostname.startsWith(".") ? hostname : `.${hostname}`;
    return raw.split(";").map((pair) => {
      const eqIdx = pair.indexOf("=");
      if (eqIdx < 0) return null;
      return {
        name: pair.substring(0, eqIdx).trim(),
        value: pair.substring(eqIdx + 1).trim(),
        domain,
      };
    }).filter((c): c is CapturedCookie => c !== null && c.name.length > 0);
  } catch {
    return [];
  }
}

export async function captureSession(
  url: string,
  authHeaders?: Record<string, string>,
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }>,
  intent?: string,
  options?: { forceEphemeral?: boolean },
): Promise<CaptureResult> {
  await acquireTabSlot();

  // Ensure Kuri is running and tabs are discovered
  await kuri.start();
  await kuri.discoverTabs(); // Sync Chrome tabs into Kuri's registry

  // Get a tab for this capture
  let tabId: string;
  try {
    tabId = await kuri.getDefaultTab();
  } catch {
    // If no tabs available, try creating one
    tabId = await kuri.newTab("about:blank");
    if (!tabId) {
      tabId = await kuri.getDefaultTab();
    }
  }
  activeTabRegistry.add(tabId);

  const domain = new URL(url).hostname;
  let captureTimedOut = false;
  let retryFreshTab = false;
  let captureError: unknown;
  const timeoutHandle = setTimeout(async () => {
    captureTimedOut = true;
    await resetTab(tabId);
  }, CAPTURE_TIMEOUT_MS);

  try {
    // Set headers: client hints + auth headers
    const allHeaders = { ...CLIENT_HINT_HEADERS, ...(authHeaders ?? {}) };
    await kuri.setHeaders(tabId, allHeaders);

    // Inject cookies
    if (cookies && cookies.length > 0) {
      await injectCookies(tabId, cookies);
    }

    // Start HAR recording
    await kuri.harStart(tabId);

    // Determine page domain for JS bundle filtering
    let pageDomain: string | undefined;
    try { pageDomain = getRegistrableDomain(new URL(url).hostname); } catch { /* bad url */ }

    // Inject fetch/XHR interceptor BEFORE navigation to capture all response bodies
    // Navigate to origin first so the interceptor runs in the correct context
    try {
      const origin = new URL(url).origin;
      await kuri.navigate(tabId, origin);
      await new Promise((r) => setTimeout(r, 500));
    } catch { /* best-effort */ }

    await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT);

    // Navigate to target URL
    await kuri.navigate(tabId, url);

    // Re-inject interceptor after navigation (page context resets on navigate)
    try {
      await new Promise((r) => setTimeout(r, 300));
      await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT);
    } catch { /* page may not be ready */ }

    // Build response bodies map from intercepted requests
    const responseBodies = new Map<string, string>();
    const jsBundleBodies = new Map<string, string>();
    const MAX_JS_BUNDLES = 20;

    // Adaptive wait: handle Cloudflare challenges + SPA content loading + intent-aware API wait
    await waitForContentReady(tabId, url, intent, responseBodies);

    // Collect all intercepted requests
    const intercepted = await collectInterceptedRequests(tabId);

    // Separate JS bundles from data responses
    for (const entry of intercepted) {
      if (entry.is_js && jsBundleBodies.size < MAX_JS_BUNDLES && pageDomain) {
        try {
          const jsDomain = getRegistrableDomain(new URL(entry.url).hostname);
          if (jsDomain === pageDomain && entry.response_body) {
            jsBundleBodies.set(entry.url, entry.response_body);
          }
        } catch { /* bad url */ }
      } else if (entry.response_body && !entry.is_js) {
        responseBodies.set(entry.url, entry.response_body);
      }
    }

    // Also collect via Performance API for requests the interceptor might have missed
    // (requests that started before the interceptor was injected)
    try {
      const perfResult = await kuri.evaluate(tabId, `JSON.stringify(
        performance.getEntriesByType('resource')
          .filter(function(e) { return e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest'; })
          .map(function(e) { return { url: e.name, duration: e.duration }; })
      )`);
      // Performance API only gives us URLs, not bodies — but useful for request tracking
    } catch { /* non-fatal */ }

    // Stop HAR recording and merge with intercepted data
    let harEntries: kuri.KuriHarEntry[] = [];
    try {
      const harResult = await kuri.harStop(tabId);
      harEntries = harResult.entries;
    } catch { /* HAR may not be available */ }

    const har_lineage_id = nanoid();

    // Debug: log captured counts
    log("capture", `tracked ${harEntries.length} HAR entries, ${intercepted.length} intercepted, ${responseBodies.size} response bodies`);
    for (const [bodyUrl] of responseBodies) {
      log("capture", `response body captured: ${bodyUrl.substring(0, 150)}`);
    }

    let final_url = url;
    let html: string | undefined;
    try {
      final_url = await kuri.getCurrentUrl(tabId);
      html = await kuri.getPageHtml(tabId);
    } catch {}

    // Build requests from HAR entries
    const requests: RawRequest[] = harEntries.map((entry) => {
      const reqHeaders: Record<string, string> = {};
      for (const h of entry.request.headers) reqHeaders[h.name] = h.value;
      const respHeaders: Record<string, string> = {};
      for (const h of entry.response.headers) respHeaders[h.name] = h.value;
      return {
        url: entry.request.url,
        method: entry.request.method,
        request_headers: reqHeaders,
        request_body: entry.request.postData?.text,
        response_status: entry.response.status,
        response_headers: respHeaders,
        response_body: responseBodies.get(entry.request.url) ?? entry.response.content?.text,
        timestamp: entry.startedDateTime,
      };
    });

    // Synthesize RawRequests for intercepted responses not in HAR
    const harUrls = new Set(harEntries.map((e) => e.request.url));
    for (const entry of intercepted) {
      if (entry.is_js) continue;
      if (!harUrls.has(entry.url)) {
        requests.push({
          url: entry.url,
          method: entry.method,
          request_headers: entry.request_headers,
          request_body: entry.request_body,
          response_status: entry.response_status,
          response_headers: entry.response_headers,
          response_body: entry.response_body,
          timestamp: entry.timestamp,
        });
      }
    }

    // Synthesize RawRequests for response bodies captured during intent-aware wait
    const allTrackedUrls = new Set([...harUrls, ...intercepted.map((e) => e.url)]);
    for (const [bodyUrl, body] of responseBodies) {
      if (!allTrackedUrls.has(bodyUrl)) {
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

    // Extract session cookies via document.cookie
    const rawCookies = await extractCookiesFromPage(tabId, url);
    const sessionCookies = filterFirstPartySessionCookies(rawCookies, url, final_url);

    if (captureTimedOut) throw new Error(`captureSession timed out after ${CAPTURE_TIMEOUT_MS}ms for ${url}`);
    log("capture", `captured ${jsBundleBodies.size} JS bundles for route scanning`);

    const responseBodyCount = responseBodies.size;
    if (
      isBlockedAppShell(html) &&
      responseBodyCount < 10 &&
      !hasUsefulCapturedResponses(responseBodies.keys(), url, intent)
    ) {
      retryFreshTab = true;
      log("capture", `rendered blocked app shell for ${url}; retrying with fresh tab`);
    } else {
      return {
        requests,
        har_lineage_id,
        domain,
        cookies: sessionCookies.length > 0 ? sessionCookies : undefined,
        final_url,
        // WebSocket capture skipped (Kuri limitation)
        ws_messages: undefined,
        html,
        js_bundles: jsBundleBodies.size > 0 ? jsBundleBodies : undefined,
      };
    }
  } catch (error) {
    captureError = error;
    if (shouldRetryEphemeralProfileError(error)) {
      retryFreshTab = true;
      log("capture", `tab failed for ${url}; retrying with fresh tab (${error instanceof Error ? error.message : String(error)})`);
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timeoutHandle);
    await resetTab(tabId);
    releaseTabSlot(tabId);
  }
  if (retryFreshTab) {
    return captureSession(url, authHeaders, cookies, intent, { forceEphemeral: true });
  }
  if (captureError) throw captureError;
  throw new Error(`captureSession failed without returning a result for ${url}`);
}

export async function executeInBrowser(
  url: string,
  method: string,
  requestHeaders: Record<string, string>,
  body?: unknown,
  authHeaders?: Record<string, string>,
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }>
): Promise<{ status: number; data: unknown; trace_id: string }> {
  await kuri.start();
  await kuri.discoverTabs();

  let tabId: string;
  try {
    tabId = await kuri.newTab("about:blank");
    if (!tabId) tabId = await kuri.getDefaultTab();
  } catch {
    tabId = await kuri.getDefaultTab();
  }
  activeTabRegistry.add(tabId);

  try {
    const allHeaders = { ...CLIENT_HINT_HEADERS, ...authHeaders, ...requestHeaders };
    await kuri.setHeaders(tabId, allHeaders);

    if (cookies && cookies.length > 0) {
      await injectCookies(tabId, cookies);
    }

    // Navigate to origin so in-page fetch inherits cookies/CORS
    const origin = new URL(url).origin;
    await kuri.navigate(tabId, origin);
    await waitForReadyState(tabId, 5000);

    const result = await kuri.executeInPageFetch(tabId, url, method, requestHeaders, body);
    return { ...result, trace_id: nanoid() };
  } finally {
    await resetTab(tabId);
    releaseTabSlot(tabId);
  }
}

/**
 * Trigger-and-intercept execution: navigate to the page that originally
 * triggered an API call, let the site's own JS make the request (passing
 * CSRF checks, TLS fingerprinting, etc.), and intercept the response.
 *
 * Uses the injected fetch/XHR interceptor to capture the target API response.
 */
export async function triggerAndIntercept(
  triggerUrl: string,
  targetUrlPattern: string,
  cookies: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }>,
  authHeaders?: Record<string, string>,
): Promise<{ status: number; data: unknown; trace_id: string }> {
  await acquireTabSlot();
  await kuri.start();
  await kuri.discoverTabs();

  let tabId: string;
  try {
    tabId = await kuri.newTab("about:blank");
    if (!tabId) tabId = await kuri.getDefaultTab();
  } catch {
    tabId = await kuri.getDefaultTab();
  }
  activeTabRegistry.add(tabId);

  try {
    // Set headers
    const headers = { ...CLIENT_HINT_HEADERS, ...authHeaders };
    await kuri.setHeaders(tabId, headers);
    await injectCookies(tabId, cookies);

    // Build a URL matcher
    const targetBase = targetUrlPattern.replace(/\{[^}]+\}/g, "").split("?")[0];
    let targetQueryId: string | null = null;
    try {
      const tu = new URL(targetUrlPattern.replace(/\{[^}]+\}/g, "x"));
      const rawQueryId = tu.searchParams.get("queryId");
      targetQueryId = rawQueryId ? rawQueryId.split(".")[0] : null;
    } catch { /* skip */ }

    log("capture", `trigger-and-intercept: navigating to ${triggerUrl}, waiting for ${targetBase}${targetQueryId ? `?queryId=${targetQueryId.slice(0, 40)}` : ""}`);

    // Navigate to trigger origin first, inject interceptor
    try {
      const origin = new URL(triggerUrl).origin;
      await kuri.navigate(tabId, origin);
      await new Promise((r) => setTimeout(r, 500));
      await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT);
    } catch { /* best-effort */ }

    // Navigate to the trigger page — the site's JS will make the API call
    await kuri.navigate(tabId, triggerUrl);
    // Re-inject interceptor after navigation
    try {
      await new Promise((r) => setTimeout(r, 300));
      await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT);
    } catch { /* page may not be ready */ }

    // Poll for the target response
    const POLL_INTERVAL = 1000;
    const MAX_WAIT = 15000;
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      const intercepted = await collectInterceptedRequests(tabId);
      for (const entry of intercepted) {
        const respUrl = entry.url;
        const baseMatch = respUrl.includes(targetBase);
        const queryIdMatch = !targetQueryId || respUrl.includes(targetQueryId);
        if (baseMatch && queryIdMatch) {
          let data: unknown = entry.response_body;
          try { data = JSON.parse(entry.response_body ?? ""); } catch { /* keep as string */ }
          log("capture", `trigger-and-intercept: got status ${entry.response_status} for ${targetBase}`);
          return { status: entry.response_status, data, trace_id: nanoid() };
        }
      }
    }

    log("capture", `trigger-and-intercept: timeout waiting for ${targetBase}`);
    return {
      status: 0,
      data: { error: "trigger_timeout", message: "Target API call not intercepted within 15s" },
      trace_id: nanoid(),
    };
  } finally {
    await resetTab(tabId);
    releaseTabSlot(tabId);
  }
}
