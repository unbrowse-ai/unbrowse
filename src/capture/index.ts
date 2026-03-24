import * as kuri from "../kuri/client.js";
import { nanoid } from "nanoid";
import { getRegistrableDomain, isDomainMatch } from "../domain.js";
import { log } from "../logger.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { BrowserAuthSourceMeta } from "../auth/browser-cookies.js";
import { browserCdpBaseUrl, launchChromiumProfileContext, primeChromiumProfileContext } from "../auth/profile-context.js";
import {
  deriveInteractionClickTerms,
  deriveInteractionQueryTerms,
  shouldAttemptInteractiveExploration,
} from "./interaction.js";
import { fetchHtmlDocument, submitLikelyHtmlSearchForm } from "./form-submit.js";

// BUG-GC-012: Use a real Chrome UA — HeadlessChrome is actively blocked by Google and others.
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Stealth script — hides headless Chrome indicators from bot detection.
// Ported from kuri's cdp/js/stealth.js (commit 4dbbd89).
const STEALTH_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const p = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    p.length = 3;
    return p;
  },
  configurable: true,
});
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {}, id: undefined };
const origQuery = window.navigator.permissions?.query;
if (origQuery) {
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(p);
}
try {
  const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (d) Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', { get: function() { return d.get.call(this); } });
} catch {}
Object.defineProperty(navigator, 'userAgent', {
  get: () => '${CHROME_UA}',
  configurable: true,
});
`;

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

type CaptureAuthStrategy = "header-replay" | "cookie-injection";

const AUTH_STRATEGY_CACHE_FILE = join(os.homedir(), ".unbrowse", "auth-strategy-cache.json");
const authStrategyCache = new Map<string, {
  preferred?: CaptureAuthStrategy;
  cookieInjectionUnsafe?: boolean;
  updatedAt: number;
}>();

function loadAuthStrategyCache(): void {
  try {
    if (!existsSync(AUTH_STRATEGY_CACHE_FILE)) return;
    const parsed = JSON.parse(readFileSync(AUTH_STRATEGY_CACHE_FILE, "utf8")) as Record<string, {
      preferred?: CaptureAuthStrategy;
      cookieInjectionUnsafe?: boolean;
      updatedAt?: number;
    }>;
    for (const [domain, entry] of Object.entries(parsed)) {
      authStrategyCache.set(domain, {
        preferred: entry.preferred,
        cookieInjectionUnsafe: entry.cookieInjectionUnsafe === true,
        updatedAt: entry.updatedAt ?? Date.now(),
      });
    }
  } catch {
    // best-effort cache
  }
}

function persistAuthStrategyCache(): void {
  try {
    mkdirSync(join(os.homedir(), ".unbrowse"), { recursive: true });
    writeFileSync(AUTH_STRATEGY_CACHE_FILE, JSON.stringify(Object.fromEntries(authStrategyCache), null, 2), "utf8");
  } catch {
    // best-effort cache
  }
}

loadAuthStrategyCache();

function captureAbortError(): Error & { code: "aborted" } {
  return Object.assign(new Error("capture_aborted"), { code: "aborted" as const, name: "AbortError" });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw captureAbortError();
}

async function fetchBundleBodiesFromHtml(options: {
  html: string;
  pageUrl: string;
  authHeaders?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain: string }>;
  maxBundles: number;
  signal?: AbortSignal;
}): Promise<Map<string, string>> {
  const bundles = new Map<string, string>();
  let page: URL;
  try {
    page = new URL(options.pageUrl);
  } catch {
    return bundles;
  }
  const pageDomain = getRegistrableDomain(page.hostname);
  if (!pageDomain) return bundles;

  const cookieHeader = (options.cookies ?? [])
    .filter((cookie) => isDomainMatch(page.hostname, cookie.domain))
    .map((cookie) => {
      const value = cookie.value.startsWith('"') && cookie.value.endsWith('"')
        ? cookie.value.slice(1, -1)
        : cookie.value;
      return `${cookie.name}=${value}`;
    })
    .join("; ");

  const urls = [...options.html.matchAll(/<script[^>]+src="([^"]+)"[^>]*>/gi)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);

  const prioritizedUrls = urls
    .map((candidate) => ({
      candidate,
      score:
        (/\/_next\/static\/chunks\//i.test(candidate) ? 40 : 0) +
        (/[a-f0-9]{8,}\.js(?:[?#]|$)/i.test(candidate) ? 12 : 0) -
        (/_buildManifest|_ssgManifest|turbopack|webpack|polyfills/i.test(candidate) ? 80 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.candidate);

  for (const candidate of prioritizedUrls) {
    if (bundles.size >= options.maxBundles) break;
    throwIfAborted(options.signal);

    let resolved: URL;
    try {
      resolved = new URL(candidate, page);
    } catch {
      continue;
    }

    const bundleDomain = getRegistrableDomain(resolved.hostname);
    if (bundleDomain !== pageDomain) continue;
    if (!/\.js(?:[?#]|$)/i.test(resolved.pathname + resolved.search)) continue;
    if (bundles.has(resolved.toString())) continue;

    try {
      const response = await fetch(resolved.toString(), {
        method: "GET",
        headers: {
          accept: "application/javascript,text/javascript,*/*;q=0.8",
          ...CLIENT_HINT_HEADERS,
          ...(options.authHeaders ?? {}),
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
          referer: page.toString(),
        },
        redirect: "follow",
        signal: options.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || (!/javascript|ecmascript|text\/plain/i.test(contentType) && !/\.js(?:[?#]|$)/i.test(resolved.pathname))) {
        continue;
      }
      const text = await response.text();
      if (text) bundles.set(resolved.toString(), text);
    } catch {
      /* best-effort */
    }
  }

  return bundles;
}

export async function recoverCaptureViaDocumentFetch(options: {
  url: string;
  authHeaders?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; domain: string; path?: string; httpOnly?: boolean; secure?: boolean }>;
  signal?: AbortSignal;
  prefetched?: { html: string; final_url: string };
}): Promise<CaptureResult | null> {
  let domain = "";
  try {
    domain = new URL(options.url).hostname;
  } catch {
    return null;
  }

  const fetchedDocument = options.prefetched
    ? {
        final_url: options.prefetched.final_url || options.url,
        html: options.prefetched.html,
      }
    : await fetchHtmlDocument({
        url: options.url,
        authHeaders: options.authHeaders ?? {},
        cookies: options.cookies ?? [],
        referer: options.url,
      }).catch(() => null);
  if (!fetchedDocument?.html) return null;

  const final_url = fetchedDocument.final_url || options.url;
  const sessionCookies = filterFirstPartySessionCookies(options.cookies ?? [], options.url, final_url);
  const jsBundles = await fetchBundleBodiesFromHtml({
    html: fetchedDocument.html,
    pageUrl: final_url,
    authHeaders: options.authHeaders,
    cookies: sessionCookies.length > 0 ? sessionCookies : options.cookies,
    maxBundles: 60,
    signal: options.signal,
  }).catch(() => new Map<string, string>());

  return {
    requests: [],
    har_lineage_id: nanoid(),
    domain,
    cookies: sessionCookies.length > 0 ? sessionCookies : undefined,
    final_url,
    html: fetchedDocument.html,
    js_bundles: jsBundles.size > 0 ? jsBundles : undefined,
  };
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(captureAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function withCaptureStepTimeout<T>(
  label: string,
  ms: number,
  signal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await Promise.race([
    fn(),
    (async () => {
      await sleep(ms, signal);
      throw new Error(`${label}_timeout`);
    })(),
  ]);
}

function looksLikeSearchDocument(html?: string): boolean {
  if (!html) return false;
  return /name=["'](?:basicSearchKey|q|query|search|keyword|searchTerm|searchText)["']/i.test(html)
    || /placeholder=["'][^"']*(?:search|keyword|query|citation|case)/i.test(html)
    || /action=[^>]*(?:search|result|lookup|find)/i.test(html);
}

async function resetTab(tabId: string): Promise<void> {
  try {
    await kuri.navigate(tabId, "about:blank");
  } catch { /* best-effort */ }
}

async function cleanupTab(tabId: string, closeTab = false): Promise<void> {
  if (closeTab) {
    try {
      await kuri.closeTab(tabId);
      return;
    } catch {
      // fall back to a soft reset when close fails
    }
  }
  await resetTab(tabId);
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
    /#placeholder,\s*#react-root\s*\{\s*display:\s*none/i.test(html) ||
    /Attention Required!\s*\|\s*Cloudflare/i.test(html) ||
    /cf-error-details|cf\.errors\.css/i.test(html)
  );
}

export function blockedAppShellErrorCode(
  html: string | undefined,
  hasAuth: boolean,
): "auth_required" | "blocked_app_shell" {
  if (html && /Cloudflare|cf\.errors\.css|cf-error-details/i.test(html)) {
    return "auth_required";
  }
  return hasAuth ? "blocked_app_shell" : "auth_required";
}

export function shouldShortCircuitEmbeddedPayloadCapture(url: string, intent: string | undefined, html?: string): boolean {
  if (!html) return false;
  const lowerIntent = intent?.toLowerCase() ?? "";
  if (
    /linkedin\.com/i.test(url) &&
    /\/feed(?:\/|$)/i.test(url) &&
    /\b(feed|timeline|stream|post|posts|update|updates|home)\b/.test(lowerIntent) &&
    /voyagerFeedDashMainFeed/.test(html)
  ) {
    return true;
  }
  return false;
}

function shouldRetryEphemeralProfileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /persistentcontext|target page, context or browser has been closed|browser has been closed|page has been closed/i.test(message);
}

export function shouldRestartKuriForError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /CDP command failed|target closed|session closed|No target with given id|No tabs available and failed to create one/i.test(message);
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
    derivedHints.add("mainfeed");
    derivedHints.add("feeddash");
    derivedHints.add("feedupdate");
    derivedHints.add("voyagerfeed");
    derivedHints.add("feed");
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
  signal?: AbortSignal,
): Promise<void> {
  if (!captureUrl || !responseBodies) return;
  throwIfAborted(signal);
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
        throwIfAborted(signal);
        if (hasCapturedHint(responseBodies.keys(), "/guild")) break;
        log("spa", `probing ${probe.label}: GET https://discord.com${probe.path}`);
        await kuri.evaluate(tabId, `(async function() {
          try {
            var response = await fetch(${JSON.stringify(probe.path)}, { credentials: "include" });
            await response.text();
          } catch(e) { /* best-effort probe */ }
        })()`);
        await sleep(1200, signal);
      }
    } catch {
      // non-fatal
    }
  }
}

const CAPTURE_RESPONSE_NOISE = /user_flow|datasavermode|ces\/p2|intercom|badge_count|settings\.json|paymentfailure|saved_searches|launcher_settings|conversations|\/ping\b|verifiedorg|xchatdmsettings|scheduledpromotions|storytopic|sidebaruserrecommendations|subscriptions|realtimefrontendtimestamp|allowlist\/voyager-web-feed|voyagermessaginggraphql|live_pipeline|fleetline|authorizetoken|logintwittertoken/i;

function isUsefulCapturedResponseUrl(url: string): boolean {
  return !CAPTURE_RESPONSE_NOISE.test(url);
}

export function hasUsefulCapturedResponses(
  responseUrls: Iterable<string>,
  captureUrl?: string,
  intent?: string,
): boolean {
  const usefulUrls = [...responseUrls].filter(isUsefulCapturedResponseUrl);
  if (usefulUrls.length === 0) return false;
  const hints = deriveIntentHints(captureUrl, intent);
  if (hints.length === 0) return usefulUrls.length > 0;
  return usefulUrls.some((url) => {
    const lower = url.toLowerCase();
    return hints.some((hint) => lower.includes(hint));
  });
}

export function hasUsefulCapturedResponsesBeyondPageShell(
  responseUrls: Iterable<string>,
  captureUrl?: string,
  intent?: string,
): boolean {
  const usefulUrls = [...responseUrls].filter(isUsefulCapturedResponseUrl);
  if (usefulUrls.length === 0) return false;
  const lowerIntent = intent?.toLowerCase() ?? "";
  const isSearchLikeIntent = /\b(search|find|lookup|browse|discover)\b/.test(lowerIntent);
  if (!isSearchLikeIntent || !captureUrl) {
    return hasUsefulCapturedResponses(usefulUrls, captureUrl, intent);
  }

  let captureHref = "";
  try {
    const parsed = new URL(captureUrl);
    captureHref = `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return hasUsefulCapturedResponses(usefulUrls, captureUrl, intent);
  }

  const offPageUrls = usefulUrls.filter((url) => {
    try {
      const parsed = new URL(url, captureUrl);
      return `${parsed.origin}${parsed.pathname}${parsed.search}` !== captureHref;
    } catch {
      return true;
    }
  });
  if (offPageUrls.length === 0) return false;
  return true;
}

/**
 * Inject a fetch/XHR interceptor into the page to capture request/response data.
 * Returns captured entries via __unbrowse_intercepted global.
 */
function buildInterceptorScript(previewUnsafeActions = false): string {
  return `
(function() {
  window.__unbrowse_preview_unsafe_actions = ${previewUnsafeActions ? "true" : "false"};
  if (window.__unbrowse_interceptor_installed) return;
  window.__unbrowse_interceptor_installed = true;
  window.__unbrowse_intercepted = [];

  var BODY_LIMIT = 524288;
  var JS_LIMIT = 2097152;
  var MAX_ENTRIES = 500;
  var JS_RE = /\\.js(\\?|$)/;
  var ASSET_RE = /\\.(css|woff2?|png|jpg|svg|ico)(\\?|$)/;
  var PREVIEW_BODY = '{"dry_run":true,"preview_blocked":true}';

  function isInteresting(url, contentType) {
    return contentType.indexOf('application/json') !== -1 ||
      contentType.indexOf('+json') !== -1 ||
      contentType.indexOf('application/x-protobuf') !== -1 ||
      contentType.indexOf('text/plain') !== -1 ||
      url.indexOf('batchexecute') !== -1 ||
      url.indexOf('/api/') !== -1;
  }

  function shouldPreviewBlock(method) {
    return window.__unbrowse_preview_unsafe_actions && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  }

  function pushEntry(entry) {
    if (window.__unbrowse_intercepted.length < MAX_ENTRIES) {
      window.__unbrowse_intercepted.push(entry);
    }
  }

  function captureHeaders(headers) {
    var out = {};
    if (!headers) return out;
    if (typeof headers.forEach === 'function') {
      headers.forEach(function(value, key) { out[key] = value; });
      return out;
    }
    Object.keys(headers).forEach(function(key) { out[key] = headers[key]; });
    return out;
  }

  function recordPreviewBlocked(url, method, requestHeaders, requestBody) {
    pushEntry({
      url: url,
      method: method,
      request_headers: requestHeaders,
      request_body: requestBody,
      response_status: 200,
      response_headers: { 'content-type': 'application/json' },
      response_body: PREVIEW_BODY,
      content_type: 'application/json',
      is_js: false,
      preview_blocked: true,
      timestamp: new Date().toISOString(),
    });
  }

  var originalFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
    var options = args[1] || {};
    var method = (options.method || 'GET').toUpperCase();
    var requestBody = options.body ? String(options.body).substring(0, BODY_LIMIT) : undefined;
    var requestHeaders = captureHeaders(options.headers);

    if (shouldPreviewBlock(method)) {
      recordPreviewBlocked(url, method, requestHeaders, requestBody);
      return Promise.resolve(new Response(PREVIEW_BODY, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }

    return originalFetch.apply(this, args).then(function(response) {
      if (window.__unbrowse_intercepted.length >= MAX_ENTRIES) return response;
      var contentType = response.headers.get('content-type') || '';
      var isJs = contentType.indexOf('javascript') !== -1 || JS_RE.test(url);
      if ((!isJs && !isInteresting(url, contentType)) || ASSET_RE.test(url)) return response;
      response.clone().text().then(function(body) {
        if (body.length > (isJs ? JS_LIMIT : BODY_LIMIT)) return;
        pushEntry({
          url: url,
          method: method,
          request_headers: requestHeaders,
          request_body: requestBody,
          response_status: response.status,
          response_headers: captureHeaders(response.headers),
          response_body: body,
          content_type: contentType,
          is_js: isJs,
          timestamp: new Date().toISOString(),
        });
      }).catch(function() {});
      return response;
    }).catch(function(error) {
      throw error;
    });
  };

  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__unbrowse_method = method;
    this.__unbrowse_url = url;
    this.__unbrowse_reqHeaders = {};
    var originalSetRequestHeader = this.setRequestHeader.bind(this);
    this.setRequestHeader = function(key, value) {
      this.__unbrowse_reqHeaders[key] = value;
      originalSetRequestHeader(key, value);
    }.bind(this);
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    var xhr = this;
    var method = (xhr.__unbrowse_method || 'GET').toUpperCase();
    var url = xhr.__unbrowse_url || '';
    var requestBody = body ? String(body).substring(0, BODY_LIMIT) : undefined;

    if (shouldPreviewBlock(method)) {
      recordPreviewBlocked(url, method, xhr.__unbrowse_reqHeaders || {}, requestBody);
      try { Object.defineProperty(xhr, 'readyState', { configurable: true, value: 4 }); } catch {}
      try { Object.defineProperty(xhr, 'status', { configurable: true, value: 200 }); } catch {}
      try { Object.defineProperty(xhr, 'responseText', { configurable: true, value: PREVIEW_BODY }); } catch {}
      try { Object.defineProperty(xhr, 'response', { configurable: true, value: PREVIEW_BODY }); } catch {}
      try { Object.defineProperty(xhr, 'responseURL', { configurable: true, value: String(url) }); } catch {}
      xhr.getResponseHeader = function(name) {
        return /content-type/i.test(String(name || '')) ? 'application/json' : null;
      };
      xhr.getAllResponseHeaders = function() {
        return 'content-type: application/json\\r\\n';
      };
      setTimeout(function() {
        if (typeof xhr.onreadystatechange === 'function') xhr.onreadystatechange(new Event('readystatechange'));
        xhr.dispatchEvent(new Event('readystatechange'));
        if (typeof xhr.onload === 'function') xhr.onload(new Event('load'));
        xhr.dispatchEvent(new Event('load'));
        if (typeof xhr.onloadend === 'function') xhr.onloadend(new Event('loadend'));
        xhr.dispatchEvent(new Event('loadend'));
      }, 0);
      return;
    }

    xhr.addEventListener('load', function() {
      if (window.__unbrowse_intercepted.length >= MAX_ENTRIES) return;
      var contentType = xhr.getResponseHeader('content-type') || '';
      var isJs = contentType.indexOf('javascript') !== -1 || JS_RE.test(url);
      if ((!isJs && !isInteresting(url, contentType)) || ASSET_RE.test(url)) return;
      var responseBody = xhr.responseText || '';
      if (responseBody.length > (isJs ? JS_LIMIT : BODY_LIMIT)) return;
      pushEntry({
        url: url,
        method: method,
        request_headers: xhr.__unbrowse_reqHeaders || {},
        request_body: requestBody,
        response_status: xhr.status,
        response_headers: {},
        response_body: responseBody,
        content_type: contentType,
        is_js: isJs,
        timestamp: new Date().toISOString(),
      });
    });

    return originalSend.apply(xhr, arguments);
  };
})()`;
}

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

async function mergeInterceptedResponses(
  tabId: string,
  responseBodies: Map<string, string>,
): Promise<number> {
  const before = responseBodies.size;
  const intercepted = await collectInterceptedRequests(tabId);
  for (const entry of intercepted) {
    if (entry.response_body && !entry.is_js) {
      responseBodies.set(entry.url, entry.response_body);
    }
  }
  return responseBodies.size - before;
}

async function settleAfterInteractiveStimulus(
  tabId: string,
  responseBodies: Map<string, string>,
  previewUnsafeActions = false,
  signal?: AbortSignal,
): Promise<number> {
  const baseline = responseBodies.size;
  const deadline = Date.now() + 4_000;
  let lastAdded = 0;
  while (Date.now() < deadline) {
    await sleep(400, signal);
    try {
      await kuri.evaluate(tabId, STEALTH_SCRIPT);
      await kuri.evaluate(tabId, buildInterceptorScript(previewUnsafeActions));
    } catch {
      // page may still be navigating
    }
    lastAdded = await mergeInterceptedResponses(tabId, responseBodies);
    if (responseBodies.size > baseline) return responseBodies.size - baseline;
  }
  return lastAdded;
}

async function performRealClickForToken(
  tabId: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false;
  const geometry = parseInteractiveStimulusResult(
    await kuri.evaluate(
      tabId,
      `(function(token){
        const selector = '[data-unbrowse-action-token="' + String(token).replace(/"/g, '\\"') + '"]';
        const el = document.querySelector(selector);
        if (!(el instanceof HTMLElement)) return JSON.stringify({ ok: false });
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return JSON.stringify({ ok: false });
        return JSON.stringify({
          ok: true,
          x: rect.left + (rect.width / 2),
          y: rect.top + Math.min(rect.height / 2, Math.max(8, rect.height - 8)),
        });
      })(${JSON.stringify(token)})`,
    ),
  );

  const x = typeof geometry?.x === "number" ? geometry.x : Number.NaN;
  const y = typeof geometry?.y === "number" ? geometry.y : Number.NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  await kuri.dispatchRealClick(tabId, x, y);
  return true;
}

async function maybePreviewSubmitActionFlow(
  tabId: string,
  captureUrl: string,
  intent: string | undefined,
  responseBodies: Map<string, string>,
  previewUnsafeActions: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!previewUnsafeActions) return false;
  const lowerIntent = intent?.toLowerCase() ?? "";
  if (!/\b(register|rsvp|join|apply|signup|sign up|book|reserve|checkout|purchase|order|submit)\b/.test(lowerIntent)) {
    return false;
  }

  const actionTerms = deriveInteractionClickTerms(captureUrl, intent);
  let lastSignature = "";

  for (let step = 0; step < 3; step++) {
    const previewResult = await kuri.evaluate(
      tabId,
      `(function(spec){
        const visible = (el) => {
          if (!el || !(el instanceof Element)) return false;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const textFor = (el) => [
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('placeholder'),
          el.getAttribute('name'),
          el.getAttribute('id'),
          el.getAttribute('action'),
          el.getAttribute('role'),
        ].filter(Boolean).join(' ').toLowerCase();
        const fieldValue = (el) => {
          const text = textFor(el);
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (type === 'email' || /email/.test(text)) return 'preview@example.com';
          if (/telegram/.test(text)) return 'preview_telegram';
          if (/twitter|x handle/.test(text)) return 'preview_user';
          if (/linkedin/.test(text)) return 'preview-linkedin';
          if (/github/.test(text)) return 'preview-github';
          if (type === 'tel' || /phone|mobile|whatsapp/.test(text)) return '+14155550123';
          if (/first/.test(text)) return 'Preview';
          if (/last/.test(text)) return 'User';
          if (/company|organization|organisation/.test(text)) return 'Preview Co';
          if (/job title|title/.test(text)) return 'Builder';
          if (/name/.test(text)) return 'Preview User';
          if (type === 'url') return 'https://example.com';
          return 'preview';
        };
        const setInputValue = (el, value) => {
          const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const fillWidget = (el, touched) => {
          if (!(el instanceof HTMLElement) || !visible(el)) return false;
          if (el instanceof HTMLInputElement) {
            const type = (el.type || 'text').toLowerCase();
            if (['hidden', 'submit', 'button', 'image', 'file'].includes(type)) return false;
            if (['checkbox', 'radio'].includes(type)) {
              if (!el.checked) el.click();
              touched.push(el.name || el.id || type);
              return true;
            }
            if (!el.value) setInputValue(el, fieldValue(el));
            touched.push(el.name || el.id || type);
            return true;
          }
          if (el instanceof HTMLTextAreaElement) {
            if (!el.value) setInputValue(el, fieldValue(el));
            touched.push(el.name || el.id || 'textarea');
            return true;
          }
          if (el instanceof HTMLSelectElement) {
            const options = [...el.options].filter((opt) => !opt.disabled && opt.value !== '');
            if (options[0] && !el.value) {
              el.value = options[0].value;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            touched.push(el.name || el.id || 'select');
            return true;
          }
          if (el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox') {
            if (!el.textContent) el.textContent = fieldValue(el);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            touched.push(el.getAttribute('name') || el.id || 'textbox');
            return true;
          }
          if (el.getAttribute('role') === 'combobox') {
            el.click();
            const option = [...document.querySelectorAll('[role="option"], [role="listbox"] [data-value], [role="listbox"] button')]
              .find((candidate) => candidate instanceof HTMLElement && visible(candidate) && candidate.getAttribute('aria-selected') !== 'true');
            if (option instanceof HTMLElement) option.click();
            touched.push(el.getAttribute('name') || el.id || 'combobox');
            return true;
          }
          return false;
        };
        const scoreButton = (el) => {
          const text = textFor(el);
          let score = 0;
          for (const term of spec.actionTerms) {
            if (text.includes(term.toLowerCase())) score += term.length >= 6 ? 8 : 4;
          }
          if (/register|rsvp|join|apply|ticket|checkout|purchase|submit|continue|next|confirm|finish|request to join/.test(text)) score += 10;
          if (el instanceof HTMLButtonElement) score += 2;
          return score;
        };
        const roots = [...document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], form')]
          .filter((root) => root instanceof HTMLElement && visible(root))
          .map((root) => {
            const text = textFor(root);
            let score = 0;
            for (const term of spec.actionTerms) if (text.includes(term.toLowerCase())) score += term.length >= 6 ? 8 : 4;
            if (/register|rsvp|join|apply|ticket|checkout|purchase|approval/.test(text)) score += 10;
            if (root.querySelector('input[required], textarea[required], select[required], [role="combobox"], [contenteditable="true"]')) score += 4;
            return { root, score, signature: text.slice(0, 240) };
          })
          .sort((a, b) => b.score - a.score);
        const chosen = roots[0];
        if (!chosen || chosen.score <= 0) return JSON.stringify({ action: null });
        const root = chosen.root;
        const signature = chosen.signature + '|' + root.querySelectorAll('input,textarea,select,[role="combobox"],[contenteditable="true"]').length;
        const touched = [];
        for (const el of [...root.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]')]) {
          fillWidget(el, touched);
        }
        const submitCandidates = [...root.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type]), [role="button"], [data-testid*="submit"], [data-testid*="continue"]')]
          .filter((el) => el instanceof HTMLElement && visible(el) && !el.hasAttribute('data-unbrowse-preview-clicked'))
          .map((el) => ({ el, score: scoreButton(el) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score);
        const token = 'unbrowse-' + Math.random().toString(36).slice(2, 10);
        const submit = submitCandidates[0]?.el;
        if (submit instanceof HTMLElement) {
          submit.setAttribute('data-unbrowse-action-token', token);
          submit.setAttribute('data-unbrowse-preview-clicked', '1');
          return JSON.stringify({
            action: 'preview-submit',
            touched: touched.slice(0, 20),
            score: chosen.score,
            token,
            signature,
            progressed: touched.length > 0 || submit != null,
          });
        }
        if (root instanceof HTMLFormElement && typeof root.requestSubmit === 'function') {
          root.requestSubmit();
          return JSON.stringify({
            action: 'preview-submit',
            touched: touched.slice(0, 20),
            score: chosen.score,
            submit_mode: 'requestSubmit',
            signature,
            progressed: touched.length > 0,
          });
        }
        if (root instanceof HTMLFormElement) {
          root.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          return JSON.stringify({
            action: 'preview-submit',
            touched: touched.slice(0, 20),
            score: chosen.score,
            submit_mode: 'dispatchEvent',
            signature,
            progressed: touched.length > 0,
          });
        }
        return JSON.stringify({
          action: null,
          signature,
          progressed: touched.length > 0,
        });
      })(${JSON.stringify({ actionTerms })})`,
    );
    const parsedPreviewResult = parseInteractiveStimulusResult(previewResult);
    if (!parsedPreviewResult || parsedPreviewResult.action == null) return false;
    if (typeof parsedPreviewResult.token === "string") {
      await performRealClickForToken(tabId, parsedPreviewResult.token);
    }
    log("capture", `interactive preview submit: ${JSON.stringify(parsedPreviewResult)}`);
    const added = await settleAfterInteractiveStimulus(tabId, responseBodies, previewUnsafeActions, signal);
    if (added > 0 || hasUsefulCapturedResponses(responseBodies.keys(), captureUrl, intent)) return true;
    const signature = typeof parsedPreviewResult.signature === "string" ? parsedPreviewResult.signature : "";
    const progressed = parsedPreviewResult.progressed === true;
    if (!progressed || (signature && signature === lastSignature)) break;
    lastSignature = signature;
  }

  return false;
}

function parseInteractiveStimulusResult(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

/**
 * Poll document.readyState until "complete" or timeout.
 * Replaces page.waitForLoadState("networkidle").
 */
async function waitForReadyState(tabId: string, timeoutMs = 8000, signal?: AbortSignal): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal);
    try {
      const state = await kuri.evaluate(tabId, "document.readyState");
      if (state === "complete") return;
    } catch { /* tab may not be ready */ }
    await sleep(500, signal);
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
  previewUnsafeActions = false,
  signal?: AbortSignal,
): Promise<void> {
  // Phase 1: Initial settle — let the page start rendering
  await sleep(1000, signal);

  // Early exit: if interceptor already captured API responses, page is loaded enough
  if (responseBodies && responseBodies.size > 0) {
    if (hasUsefulCapturedResponses(responseBodies.keys(), captureUrl, intent)) {
      log("capture", `early exit: ${responseBodies.size} useful API responses already captured during navigation`);
      await sleep(500, signal);
      return;
    }
    log("capture", `ignoring ${responseBodies.size} early captured responses as noise; continuing wait`);
  }

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
  await waitForReadyState(tabId, 5000, signal);

  // Early exit: check again after readyState — SPAs often fire API calls during hydration
  if (responseBodies) {
    const intercepted = await collectInterceptedRequests(tabId);
    for (const entry of intercepted) {
      if (entry.response_body && !entry.is_js) {
        responseBodies.set(entry.url, entry.response_body);
      }
    }
    if (hasUsefulCapturedResponses(responseBodies.keys(), captureUrl, intent)) {
      log("capture", `early exit after readyState: ${responseBodies.size} useful API responses captured`);
      return;
    }
  }

  // Phase 4: Intent-aware API wait — poll intercepted requests for matching API URLs
  if (captureUrl && responseBodies) {
    const derivedHints = new Set(deriveIntentHints(captureUrl, intent));
    const wantedHints = [...derivedHints].filter((hint) =>
      ![...responseBodies.keys()].some((u) => isUsefulCapturedResponseUrl(u) && u.toLowerCase().includes(hint))
    );
    if (wantedHints.length > 0) {
      log("capture", `intent-aware wait: looking for API matching one of [${wantedHints.join(", ")}] (from ${captureUrl})`);
      const intentStart = Date.now();
      const INTENT_MAX_WAIT = 8000;
      const INTENT_POLL_INTERVAL = 1000;
      while (Date.now() - intentStart < INTENT_MAX_WAIT) {
        await sleep(INTENT_POLL_INTERVAL, signal);
        // Check newly intercepted requests
        const intercepted = await collectInterceptedRequests(tabId);
        for (const entry of intercepted) {
          const respUrl = entry.url.toLowerCase();
          if (!isUsefulCapturedResponseUrl(respUrl)) continue;
          const matchedHint = wantedHints.find((hint) => respUrl.includes(hint));
          if (matchedHint) {
            log("capture", `intent-aware wait: matched ${matchedHint} via ${entry.url.substring(0, 120)}`);
            // Add to responseBodies so downstream sees it
            if (entry.response_body && !entry.is_js) {
              responseBodies.set(entry.url, entry.response_body);
            }
            await sleep(500, signal);
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
      await sleep(1200, signal);
      await kuri.evaluate(tabId, "window.scrollTo(0, 0)");
      if (responseBodies.size === before) {
        await sleep(1500, signal);
      }
    } catch {
      // non-fatal
    }
  }

  if (
    captureUrl &&
    responseBodies &&
    shouldAttemptInteractiveExploration(captureUrl, intent)
  ) {
    const queryTerms = deriveInteractionQueryTerms(captureUrl, intent);
    const clickTerms = deriveInteractionClickTerms(captureUrl, intent);
    try {
      if (queryTerms.length > 0) {
        const searchResult = await kuri.evaluate(
          tabId,
          `(function(spec) {
            const visible = (el) => {
              if (!el || !(el instanceof Element)) return false;
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };
            const scoreInput = (el) => {
              const text = [el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.type].filter(Boolean).join(' ').toLowerCase();
              let score = 0;
              if (/search|query|keyword|find/.test(text)) score += 8;
              if (/city|location|place/.test(text)) score += 4;
              if (el.type === 'search') score += 5;
              return score;
            };
            const setValue = (el, value) => {
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, value);
                else el.value = value;
              } else {
                el.textContent = value;
              }
            };
            const inputs = [...document.querySelectorAll('input, textarea, [role="searchbox"], [contenteditable="true"]')]
              .filter(visible)
              .sort((a, b) => scoreInput(b) - scoreInput(a));
            if (inputs.length === 0) return JSON.stringify({ action: null });
            const target = inputs[0];
            const term = spec.queryTerms[0];
            target.focus();
            setValue(target, term);
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
            const form = target.closest('form');
            if (form && typeof form.requestSubmit === 'function') {
              form.requestSubmit();
              return JSON.stringify({ action: 'requestSubmit', term });
            }
            const submit = (form ?? document).querySelector('button[type="submit"], input[type="submit"], button[aria-label*="search" i], button[title*="search" i]');
            if (submit instanceof HTMLElement) {
              submit.click();
              return JSON.stringify({ action: 'submit-click', term });
            }
            return JSON.stringify({ action: 'enter-only', term });
          })(${JSON.stringify({ queryTerms })})`,
        );
        const parsedSearchResult = parseInteractiveStimulusResult(searchResult);
        if (parsedSearchResult) {
          log("capture", `interactive search stimulus: ${JSON.stringify(parsedSearchResult)}`);
        }
        await settleAfterInteractiveStimulus(tabId, responseBodies, previewUnsafeActions, signal);
        if (hasUsefulCapturedResponses(responseBodies.keys(), captureUrl, intent)) return;
      }

      for (let i = 0; i < 2 && clickTerms.length > 0; i++) {
        const beforeCount = responseBodies.size;
        const clickResult = await kuri.evaluate(
          tabId,
          `(function(spec) {
            const visible = (el) => {
              if (!el || !(el instanceof Element)) return false;
              const style = window.getComputedStyle(el);
              const rect = el.getBoundingClientRect();
              return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };
            const textFor = (el) => [
              el.textContent,
              el.getAttribute('aria-label'),
              el.getAttribute('title'),
              el.getAttribute('value'),
              el.getAttribute('href'),
            ].filter(Boolean).join(' ').toLowerCase();
            const score = (el) => {
              const text = textFor(el);
              let s = 0;
              for (const term of spec.clickTerms) {
                if (text.includes(term.toLowerCase())) s += term.length >= 6 ? 8 : 4;
              }
              if (/(button|tab)/.test((el.getAttribute('role') || '').toLowerCase())) s += 1;
              if (el.tagName === 'BUTTON') s += 2;
              if (/load more|show more|register|rsvp|join|search|discover|next/.test(text)) s += 4;
              return s;
            };
            const candidates = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], input[type="button"], input[type="submit"]')]
              .filter(visible)
              .filter((el) => !el.hasAttribute('data-unbrowse-clicked'))
              .map((el) => ({ el, label: textFor(el), score: score(el) }))
              .filter((entry) => entry.score > 0)
              .sort((a, b) => b.score - a.score);
            const chosen = candidates[0];
            if (!chosen) return JSON.stringify({ action: null });
            chosen.el.setAttribute('data-unbrowse-clicked', '1');
            const token = 'unbrowse-' + Math.random().toString(36).slice(2, 10);
            chosen.el.setAttribute('data-unbrowse-action-token', token);
            return JSON.stringify({ action: 'click', label: chosen.label.slice(0, 120), score: chosen.score, token });
          })(${JSON.stringify({ clickTerms })})`,
        );
        const parsedClickResult = parseInteractiveStimulusResult(clickResult);
        if (!parsedClickResult || !("action" in parsedClickResult) || parsedClickResult.action == null) {
          break;
        }
        if (typeof parsedClickResult.token === "string") {
          await performRealClickForToken(tabId, parsedClickResult.token);
        }
        log("capture", `interactive click stimulus: ${JSON.stringify(parsedClickResult)}`);
        const added = await settleAfterInteractiveStimulus(tabId, responseBodies, previewUnsafeActions, signal);
        if (hasUsefulCapturedResponses(responseBodies.keys(), captureUrl, intent) || responseBodies.size > beforeCount || added > 0) return;
      }
      if (await maybePreviewSubmitActionFlow(tabId, captureUrl, intent, responseBodies, previewUnsafeActions, signal)) return;
    } catch (err) {
      log("capture", `interactive stimulus failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await maybeProbeIntentApis(tabId, captureUrl, intent, responseBodies, signal);
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
  }>,
  originUrl?: string,
): Promise<{ attempted: number; injected: number }> {
  const applicable = filterCookiesForOriginHost(cookies, originUrl);

  const sanitized = applicable.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain.replace(/^\./, ""),
    ...(originUrl ? {
      url: `${new URL(originUrl).protocol}//${c.domain.replace(/^\./, "")}${c.path ?? "/"}`,
    } : {}),
    path: c.path ?? "/",
    ...(c.secure != null ? { secure: c.secure } : {}),
    ...(c.httpOnly != null ? { httpOnly: c.httpOnly } : {}),
    ...(c.sameSite != null ? { sameSite: c.sameSite } : {}),
    ...(c.expires != null && c.expires > 0 ? { expires: c.expires } : {}),
  }));

  if (sanitized.length === 0) {
    return { attempted: 0, injected: 0 };
  }

  log("capture", `injecting ${sanitized.length} cookies for domains: ${[...new Set(sanitized.map((c) => c.domain))].join(", ")}`);
  try {
    await kuri.setCookies(tabId, sanitized);
    return { attempted: sanitized.length, injected: sanitized.length };
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
    return { attempted: sanitized.length, injected };
  }
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) return false;
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function normalizeCookieValue(value: string): string {
  return value.startsWith("\"") && value.endsWith("\"") ? value.slice(1, -1) : value;
}

export function shouldUseHeaderAuthShim(
  cookies: Array<{ name: string; value: string; domain: string }>,
  originUrl?: string,
): boolean {
  const originHost = (() => {
    if (!originUrl) return null;
    try { return new URL(originUrl).hostname; } catch { return null; }
  })();
  if (!originHost) return false;
  const applicable = filterCookiesForOriginHost(cookies, originUrl);
  return applicable.length > 0;
}

export function buildHeaderAuthForOrigin(
  cookies: Array<{ name: string; value: string; domain: string }>,
  originUrl?: string,
  existingHeaders?: Record<string, string>,
): Record<string, string> {
  if (!shouldUseHeaderAuthShim(cookies, originUrl)) return {};
  const applicable = filterCookiesForOriginHost(cookies, originUrl);
  if (applicable.length === 0) return {};

  const headers: Record<string, string> = {};
  if (!hasHeader(existingHeaders, "cookie")) {
    headers.cookie = applicable
      .map((cookie) => `${cookie.name}=${normalizeCookieValue(cookie.value)}`)
      .join("; ");
  }
  if (
    !hasHeader(existingHeaders, "x-csrf-token") &&
    !hasHeader(existingHeaders, "x-xsrf-token") &&
    !hasHeader(existingHeaders, "csrf-token")
  ) {
    const csrfCookie = applicable.find((cookie) => /^(ct0|csrf_token|_csrf|csrftoken|XSRF-TOKEN|_xsrf|JSESSIONID)$/i.test(cookie.name));
    if (csrfCookie) {
      const headerName = csrfCookie.name === "JSESSIONID" ? "csrf-token" : "x-csrf-token";
      headers[headerName] = normalizeCookieValue(csrfCookie.value);
    }
  }
  return headers;
}

export function shouldFallbackToHeaderReplayAfterCookieInjection(
  strategy: CaptureAuthStrategy,
  injection: { attempted: number; injected: number },
  cookies: Array<{ name: string; value: string; domain: string }>,
  originUrl?: string,
): boolean {
  if (strategy === "header-replay") return false;
  if (injection.attempted === 0) return false;
  if (injection.injected >= injection.attempted) return false;
  return shouldUseHeaderAuthShim(cookies, originUrl);
}

function authStrategyDomain(url: string): string {
  try {
    return getRegistrableDomain(new URL(url).hostname);
  } catch {
    return "";
  }
}

export function chooseCaptureAuthStrategy(
  url: string,
  cookies?: Array<{ name: string; value: string; domain: string }>,
  authHeaders?: Record<string, string>,
  explicit?: CaptureAuthStrategy,
): CaptureAuthStrategy {
  if (explicit) return explicit;
  if (isCookieInjectionUnsafe(url)) return "header-replay";
  if (Object.keys(authHeaders ?? {}).length > 0) return "header-replay";
  if ((cookies?.length ?? 0) > 0) return "cookie-injection";
  return "cookie-injection";
}

function rememberCaptureAuthStrategy(url: string, strategy: CaptureAuthStrategy): void {
  const domain = authStrategyDomain(url);
  if (!domain) return;
  const previous = authStrategyCache.get(domain);
  authStrategyCache.set(domain, {
    preferred: strategy,
    cookieInjectionUnsafe: previous?.cookieInjectionUnsafe === true && strategy !== "cookie-injection" ? true : previous?.cookieInjectionUnsafe,
    updatedAt: Date.now(),
  });
  persistAuthStrategyCache();
}

function markCookieInjectionUnsafe(url: string): void {
  const domain = authStrategyDomain(url);
  if (!domain) return;
  const previous = authStrategyCache.get(domain);
  authStrategyCache.set(domain, {
    preferred: "header-replay",
    cookieInjectionUnsafe: true,
    updatedAt: Date.now(),
  });
  if (previous?.cookieInjectionUnsafe !== true) {
    log("capture", `marked cookie injection unsafe for ${domain}; preferring header replay`);
  }
  persistAuthStrategyCache();
}

function isCookieInjectionUnsafe(url: string): boolean {
  return authStrategyCache.get(authStrategyDomain(url))?.cookieInjectionUnsafe === true;
}

export function filterCookiesForOriginHost<T extends { domain: string }>(
  cookies: T[],
  originUrl?: string,
): T[] {
  const originHost = (() => {
    if (!originUrl) return null;
    try { return new URL(originUrl).hostname; } catch { return null; }
  })();
  if (!originHost) return cookies;
  const hostFiltered = cookies.filter((cookie) => isDomainMatch(cookie.domain, originHost));
  const registrable = getRegistrableDomain(originHost);
  if (registrable === "x.com" && hostFiltered.length > 8) {
    const preferred = new Set([
      "auth_token",
      "ct0",
      "twid",
      "kdt",
      "auth_multi",
      "lang",
      "dnt",
      "guest_id",
      "guest_id_ads",
      "guest_id_marketing",
      "personalization_id",
    ]);
    const trimmed = hostFiltered.filter((cookie) => preferred.has((cookie as { name?: string }).name ?? ""));
    if (trimmed.length > 0) return trimmed;
  }
  return hostFiltered;
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
  options?: {
    forceEphemeral?: boolean;
    signal?: AbortSignal;
    restartedKuri?: boolean;
    authStrategy?: CaptureAuthStrategy;
    triedCookieInjection?: boolean;
    authSource?: BrowserAuthSourceMeta | null;
    usedProfileContext?: boolean;
    preferExistingTab?: boolean;
    forceProfileContext?: boolean;
    previewUnsafeActions?: boolean;
  },
): Promise<CaptureResult> {
  const signal = options?.signal;
  throwIfAborted(signal);
  if (
    options?.forceProfileContext &&
    !options?.usedProfileContext &&
    options?.authSource?.family === "chromium"
  ) {
    try {
      log("capture", `forcing attached ${options.authSource.browserName} profile context for ${url}`);
      const profileCtx = await launchChromiumProfileContext(options.authSource);
      let preferExistingTab = false;
      if ((cookies?.length ?? 0) > 0) {
        const primed = await primeChromiumProfileContext(profileCtx.cdpUrl, cookies ?? [], { keepTargetOpen: true });
        preferExistingTab = !!primed.targetId;
      }
      await kuri.stop();
      kuri.useExternalChrome(browserCdpBaseUrl(profileCtx.cdpUrl), { child: profileCtx.child, tempDir: profileCtx.tempDir });
      let nestedResult: CaptureResult | null = null;
      try {
        nestedResult = await captureSession(url, undefined, undefined, intent, {
          ...options,
          forceEphemeral: true,
          usedProfileContext: true,
          preferExistingTab,
          authStrategy: "header-replay",
        });
        return nestedResult;
      } finally {
        try {
          await kuri.stop();
        } catch (stopErr) {
          log("capture", `profile-context cleanup failed for ${url}: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
          if (!nestedResult) throw stopErr;
        }
      }
    } catch (attachErr) {
      log("capture", `forced profile context failed for ${url}: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`);
    }
  }
  await acquireTabSlot();

  // Ensure Kuri is running and tabs are discovered
  throwIfAborted(signal);
  await kuri.start();
  throwIfAborted(signal);
  await kuri.discoverTabs(); // Sync Chrome tabs into Kuri's registry

  // Prefer a fresh tab so capture is isolated from stale/disconnected tabs
  // already present in the attached Chrome instance.
  let tabId: string | undefined;
  let createdFreshTab = false;
  if (options?.preferExistingTab) {
    const existingTabs = (await kuri.discoverTabs()).filter((tab) => !/^chrome-extension:|^devtools:/.test(tab.url));
    if (existingTabs[0]?.id) {
      tabId = existingTabs[0].id;
    } else {
      try {
        tabId = await kuri.newTab("about:blank");
        await kuri.discoverTabs();
        if (!tabId) {
          tabId = await kuri.getDefaultTab();
        }
        createdFreshTab = !!tabId;
      } catch {
        tabId = await kuri.getDefaultTab();
      }
    }
  } else {
    try {
      tabId = await kuri.newTab("about:blank");
      await kuri.discoverTabs();
      if (!tabId) {
        tabId = await kuri.getDefaultTab();
      }
      createdFreshTab = !!tabId;
    } catch {
      tabId = await kuri.getDefaultTab();
    }
  }
  if (!tabId) {
    throw new Error("Failed to acquire browser tab");
  }
  activeTabRegistry.add(tabId);
  let captureTimedOut = false;
  const abortListener = () => {
    captureTimedOut = true;
    void resetTab(tabId);
  };
  signal?.addEventListener("abort", abortListener, { once: true });

  const domain = new URL(url).hostname;
  let authStrategy = chooseCaptureAuthStrategy(url, cookies, authHeaders, options?.authStrategy);
  const useHeaderReplay = () => authStrategy === "header-replay";
  let retryFreshTab = false;
  let restartKuri = false;
  let restartWithAuthStrategy: CaptureAuthStrategy | null = null;
  let captureError: unknown;
  let lastHtml: string | undefined;
  const timeoutHandle = setTimeout(async () => {
    captureTimedOut = true;
    await resetTab(tabId);
  }, CAPTURE_TIMEOUT_MS);

  try {
    throwIfAborted(signal);
    // Set headers: client hints + auth headers
    const headerAuthShim = useHeaderReplay() ? buildHeaderAuthForOrigin(cookies ?? [], url, authHeaders) : {};
    const allHeaders = { ...CLIENT_HINT_HEADERS, ...(authHeaders ?? {}), ...headerAuthShim };
    await kuri.setHeaders(tabId, allHeaders);

    // Inject stealth patches — hide headless Chrome indicators from bot detection
    try {
      await kuri.evaluate(tabId, STEALTH_SCRIPT);
    } catch { /* best-effort */ }

    // Start HAR recording
    await kuri.harStart(tabId);

    // Determine page domain for JS bundle filtering
    let pageDomain: string | undefined;
    try { pageDomain = getRegistrableDomain(new URL(url).hostname); } catch { /* bad url */ }

    // Inject fetch/XHR interceptor BEFORE navigation to capture all response bodies
    // Navigate to origin first so cookies are applied in the correct domain context
    // before the full page load — required for sites like LinkedIn that check auth on first load.
    try {
      const origin = new URL(url).origin;
      log("capture", `navigating to origin: ${origin}`);
      throwIfAborted(signal);
      await kuri.navigate(tabId, origin);

      // Inject cookies AFTER origin navigation — CDP setCookie requires an active
      // page in the cookie's domain context (fails on about:blank).
      if (cookies && cookies.length > 0) {
        if (useHeaderReplay() && shouldUseHeaderAuthShim(cookies, origin)) {
          log("capture", `using header auth shim for ${origin} — skipping cookie injection`);
        } else {
          log("capture", `injecting ${cookies.length} cookies after origin nav`);
          throwIfAborted(signal);
          const injection = await injectCookies(tabId, cookies, origin);
          if (shouldFallbackToHeaderReplayAfterCookieInjection(authStrategy, injection, cookies, origin)) {
            markCookieInjectionUnsafe(url);
            authStrategy = "header-replay";
            const fallbackHeaders = buildHeaderAuthForOrigin(cookies, origin, authHeaders);
            log(
              "capture",
              `cookie injection degraded for ${origin}; switching to header replay (${injection.injected}/${injection.attempted} injected)`,
            );
            await kuri.setHeaders(tabId, {
              ...CLIENT_HINT_HEADERS,
              ...(authHeaders ?? {}),
              ...fallbackHeaders,
            });
          }
        }
      } else {
        log("capture", `no cookies to inject (cookies=${cookies?.length ?? 0})`);
      }

      throwIfAborted(signal);
      await kuri.evaluate(tabId, STEALTH_SCRIPT);
      throwIfAborted(signal);
      await kuri.evaluate(tabId, buildInterceptorScript(!!options?.previewUnsafeActions));
    } catch (originErr) {
      log("capture", `origin pre-nav failed: ${originErr instanceof Error ? originErr.message : originErr}`);
    }

    // Navigate to target URL
    throwIfAborted(signal);
    await kuri.navigate(tabId, url);

    // Re-inject stealth + interceptor after navigation (page context resets on navigate)
    try {
      await sleep(300, signal);
      throwIfAborted(signal);
      await kuri.evaluate(tabId, STEALTH_SCRIPT);
      throwIfAborted(signal);
      await kuri.evaluate(tabId, buildInterceptorScript(!!options?.previewUnsafeActions));
    } catch { /* page may not be ready */ }

    // For pages that embed the task payload directly in the HTML, return before
    // the longer network/intercept wait. This avoids losing useful captures to
    // later browser-engine instability on auth-gated SPAs like LinkedIn feed.
    try {
      await sleep(1_500, signal);
      throwIfAborted(signal);
      const earlyHtml = await kuri.getPageHtml(tabId);
      if (shouldShortCircuitEmbeddedPayloadCapture(url, intent, earlyHtml)) {
        let final_url = url;
        try {
          const rawUrl = await kuri.getCurrentUrl(tabId);
          final_url = typeof rawUrl === "string" ? rawUrl : String(rawUrl ?? url);
          try { new URL(final_url); } catch { final_url = url; }
        } catch {
          final_url = url;
        }
        lastHtml = earlyHtml;
        const rawCookies = await extractCookiesFromPage(tabId, url);
        const sessionCookies = filterFirstPartySessionCookies(rawCookies, url, final_url);
        log("capture", `short-circuiting embedded payload capture for ${url}`);
        return {
          requests: [],
          har_lineage_id: nanoid(),
          domain,
          cookies: sessionCookies,
          final_url,
          html: earlyHtml,
          js_bundles: new Map(),
        };
      }
    } catch {
      // fall through to the longer capture path
    }

    // Build response bodies map from intercepted requests
    const responseBodies = new Map<string, string>();
    const jsBundleBodies = new Map<string, string>();
    const MAX_JS_BUNDLES = 60;

    // Adaptive wait: handle Cloudflare challenges + SPA content loading + intent-aware API wait
    await waitForContentReady(tabId, url, intent, responseBodies, !!options?.previewUnsafeActions, signal);

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
      const rawUrl = await withCaptureStepTimeout("get_current_url", 5_000, signal, () => kuri.getCurrentUrl(tabId));
      final_url = typeof rawUrl === "string" ? rawUrl : String(rawUrl ?? url);
      try { new URL(final_url); } catch { final_url = url; }
    } catch (snapshotErr) {
      log("capture", `current url snapshot failed for ${url}: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`);
    }
    try {
      html = await withCaptureStepTimeout("get_page_html", 5_000, signal, () => kuri.getPageHtml(tabId));
      lastHtml = html;
    } catch (snapshotErr) {
      log("capture", `page html snapshot failed for ${url}: ${snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr)}`);
    }

    if (!hasUsefulCapturedResponsesBeyondPageShell(responseBodies.keys(), final_url, intent)) {
      const fetchedDocument = await fetchHtmlDocument({
        url,
        authHeaders: authHeaders ?? {},
        cookies: cookies ?? [],
        referer: url,
      }).catch(() => null);
      if (
        fetchedDocument?.html &&
        (!html || looksLikeSearchDocument(fetchedDocument.html) || !looksLikeSearchDocument(html))
      ) {
        html = fetchedDocument.html;
        final_url = fetchedDocument.final_url || final_url;
        lastHtml = html;
        log("capture", `direct html fallback fetched: GET ${final_url}`);
      }
    }

    // Build requests from HAR entries
    const requests: RawRequest[] = harEntries.map((entry) => {
      const reqHeaders: Record<string, string> = {};
      for (const h of entry.request.headers ?? []) reqHeaders[h.name] = h.value;
      const respHeaders: Record<string, string> = {};
      for (const h of entry.response.headers ?? []) respHeaders[h.name] = h.value;
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

    if (
      html &&
      !hasUsefulCapturedResponsesBeyondPageShell(responseBodies.keys(), final_url, intent)
    ) {
      const queryTerms = deriveInteractionQueryTerms(final_url, intent);
      const htmlFormSubmission = queryTerms[0]
        ? await submitLikelyHtmlSearchForm({
            html,
            pageUrl: final_url,
            query: queryTerms[0],
            authHeaders: authHeaders ?? {},
            cookies: cookies ?? [],
          }).catch(() => null)
        : null;
      if (htmlFormSubmission) {
        requests.push(htmlFormSubmission.request);
        if (htmlFormSubmission.request.response_body) {
          responseBodies.set(htmlFormSubmission.request.url, htmlFormSubmission.request.response_body);
        }
        if (htmlFormSubmission.html) {
          html = htmlFormSubmission.html;
          final_url = htmlFormSubmission.final_url || final_url;
          lastHtml = html;
        }
        log("capture", `html form fallback submitted: ${htmlFormSubmission.request.method} ${htmlFormSubmission.request.url}`);
      }
    }

    // Synthesize RawRequests for response bodies captured during intent-aware wait
    const allTrackedUrls = new Set(requests.map((request) => request.url));
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

    if (jsBundleBodies.size === 0 && html) {
      const fetchedBundleBodies = await fetchBundleBodiesFromHtml({
        html,
        pageUrl: final_url,
        authHeaders,
        cookies: sessionCookies.length > 0 ? sessionCookies : cookies,
        maxBundles: MAX_JS_BUNDLES,
        signal,
      });
      for (const [bundleUrl, body] of fetchedBundleBodies) {
        if (jsBundleBodies.size >= MAX_JS_BUNDLES) break;
        jsBundleBodies.set(bundleUrl, body);
      }
      if (fetchedBundleBodies.size > 0) {
        log("capture", `fetched ${fetchedBundleBodies.size} JS bundles from HTML script tags`);
      }
    }

    if (captureTimedOut) throw new Error(`captureSession timed out after ${CAPTURE_TIMEOUT_MS}ms for ${url}`);
    log("capture", `captured ${jsBundleBodies.size} JS bundles for route scanning`);

    const responseBodyCount = responseBodies.size;
    if (
      isBlockedAppShell(html) &&
      responseBodyCount < 10 &&
      !hasUsefulCapturedResponses(responseBodies.keys(), url, intent)
    ) {
      // On ephemeral retry, if still blocked by Cloudflare WAF, throw auth_required
      // so the caller can surface a login prompt instead of retrying forever
      if (options?.forceEphemeral && html && /Cloudflare|cf\.errors\.css|cf-error-details/i.test(html)) {
        throw Object.assign(new Error("cloudflare_waf_block"), {
          code: "auth_required",
          login_url: url,
        });
      }
      retryFreshTab = true;
      log("capture", `rendered blocked app shell for ${url}; retrying with fresh tab`);
    } else {
      if ((cookies?.length ?? 0) > 0 || Object.keys(authHeaders ?? {}).length > 0) {
        rememberCaptureAuthStrategy(url, authStrategy);
      }
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
    const err = error as Error & { code?: string };
    if (err.code === "cookie_injection_failed" && restartWithAuthStrategy && !options?.restartedKuri) {
      log("capture", `cookie injection failed for ${url}; restarting Kuri and retrying with ${restartWithAuthStrategy}`);
    } else if (shouldRetryEphemeralProfileError(error)) {
      retryFreshTab = true;
      log("capture", `tab failed for ${url}; retrying with fresh tab (${error instanceof Error ? error.message : String(error)})`);
    } else if (shouldRestartKuriForError(error) && !options?.restartedKuri) {
      restartKuri = true;
      log("capture", `CDP transport failed for ${url}; restarting Kuri and retrying once (${error instanceof Error ? error.message : String(error)})`);
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", abortListener);
    await cleanupTab(tabId, createdFreshTab);
    releaseTabSlot(tabId);
  }
  if (restartKuri && restartWithAuthStrategy && !options?.restartedKuri) {
    await kuri.stop();
    return captureSession(url, authHeaders, cookies, intent, {
      ...options,
      forceEphemeral: true,
      restartedKuri: true,
      authStrategy: restartWithAuthStrategy,
      triedCookieInjection: true,
    });
  }
  if (restartKuri && !options?.restartedKuri) {
    await kuri.stop();
    return captureSession(url, authHeaders, cookies, intent, { ...options, forceEphemeral: true, restartedKuri: true });
  }
  if (
    retryFreshTab &&
    !options?.usedProfileContext &&
    options?.authSource?.family === "chromium" &&
    ((cookies?.length ?? 0) === 0 && Object.keys(authHeaders ?? {}).length === 0)
  ) {
    try {
      log("capture", `managed browser auth replay was insufficient for ${url}; retrying with attached ${options.authSource.browserName} profile clone`);
      const profileCtx = await launchChromiumProfileContext(options.authSource);
      let preferExistingTab = false;
      if ((cookies?.length ?? 0) > 0) {
        const primed = await primeChromiumProfileContext(profileCtx.cdpUrl, cookies ?? [], { keepTargetOpen: true });
        preferExistingTab = !!primed.targetId;
      }
      await kuri.stop();
      kuri.useExternalChrome(browserCdpBaseUrl(profileCtx.cdpUrl), { child: profileCtx.child, tempDir: profileCtx.tempDir });
      try {
        return await captureSession(url, undefined, undefined, intent, {
          ...options,
          forceEphemeral: true,
          usedProfileContext: true,
          preferExistingTab,
          authStrategy: "header-replay",
        });
      } finally {
        await kuri.stop();
      }
    } catch (attachErr) {
      log("capture", `profile attach failed for ${url}: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`);
    }
  }
  if (retryFreshTab && !options?.forceEphemeral) {
    return captureSession(url, authHeaders, cookies, intent, { ...options, forceEphemeral: true });
  }
  if (retryFreshTab) {
    const hasAuth = !!(cookies && cookies.length > 0) || !!(authHeaders && Object.keys(authHeaders).length > 0);
    const code = blockedAppShellErrorCode(lastHtml, hasAuth);
    throw Object.assign(new Error(code), {
      code,
      login_url: url,
    });
  }
  if (captureError && shouldRestartKuriForError(captureError)) {
    const recovered = await recoverCaptureViaDocumentFetch({
      url,
      authHeaders,
      cookies,
      signal,
    });
    if (recovered) {
      log("capture", `browser transport fallback recovered ${url} via direct document fetch`);
      return recovered;
    }
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
): Promise<{ status: number; data: unknown; trace_id: string; network_events?: Array<{
  startedDateTime: string;
  request: { url: string; method: string; headers: Array<{ name: string; value: string }>; postData?: { mimeType?: string; text?: string } };
  response: { status: number; headers: Array<{ name: string; value: string }>; content?: { mimeType?: string; text?: string } };
}> }> {
  await kuri.start();
  await kuri.discoverTabs();

  let tabId: string;
  let createdFreshTab = false;
  try {
    tabId = await kuri.newTab("about:blank");
    createdFreshTab = !!tabId;
    if (!tabId) tabId = await kuri.getDefaultTab();
  } catch {
    tabId = await kuri.getDefaultTab();
  }
  activeTabRegistry.add(tabId);

  try {
    const allHeaders = { ...CLIENT_HINT_HEADERS, ...authHeaders, ...requestHeaders };
    await kuri.setHeaders(tabId, allHeaders);

    if (cookies && cookies.length > 0) {
      await injectCookies(tabId, cookies, new URL(url).origin);
    }

    // Navigate to origin so in-page fetch inherits cookies/CORS
    const origin = new URL(url).origin;
    await kuri.navigate(tabId, origin);
    await waitForReadyState(tabId, 5000);

    const startedDateTime = new Date().toISOString();
    const result = await kuri.executeInPageFetch(tabId, url, method, requestHeaders, body);
    const responseText = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
    return {
      ...result,
      trace_id: nanoid(),
      network_events: [{
        startedDateTime,
        request: {
          url,
          method: method.toUpperCase(),
          headers: Object.entries({ ...allHeaders, ...requestHeaders }).map(([name, value]) => ({ name, value: String(value) })),
          ...(body == null ? {} : {
            postData: {
              mimeType: requestHeaders["content-type"] ?? requestHeaders["Content-Type"] ?? "application/json",
              text: typeof body === "string" ? body : JSON.stringify(body),
            },
          }),
        },
        response: {
          status: result.status,
          headers: [],
          ...(responseText
            ? {
                content: {
                  mimeType: "application/json",
                  text: responseText,
                },
              }
            : {}),
        },
      }],
    };
  } finally {
    await cleanupTab(tabId, createdFreshTab);
    releaseTabSlot(tabId);
  }
}

export function matchesTriggerTargetUrl(
  currentUrl: string,
  targetBase: string,
  targetQueryId: string | null,
): boolean {
  const baseMatch = currentUrl.includes(targetBase);
  const queryIdMatch = !targetQueryId || currentUrl.includes(targetQueryId);
  return baseMatch && queryIdMatch;
}

async function waitForTriggerForm(tabId: string, targetBase: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ready = await kuri.evaluate(
        tabId,
        `(()=>[...document.forms||[]].some((f)=>String(f.action||'').includes(${JSON.stringify(targetBase)})||String(f.action||'').includes('/result-page'))||document.readyState==='complete')()`,
      );
      if (ready === true) return;
    } catch {
      // page still settling
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function isUsableDocumentNavigationHtml(html: string): boolean {
  return html.length > 1024 && /<body[\s>]/i.test(html) && /<\/body>/i.test(html);
}

async function waitForUsableDocumentNavigation(
  tabId: string,
  targetBase: string,
  targetQueryId: string | null,
  timeoutMs = 5000,
): Promise<{ currentUrl: string; currentHtml: string } | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const currentUrl = await kuri.getCurrentUrl(tabId);
      if (matchesTriggerTargetUrl(currentUrl, targetBase, targetQueryId)) {
        const currentHtml = await kuri.getPageHtml(tabId);
        if (isUsableDocumentNavigationHtml(currentHtml)) {
          return { currentUrl, currentHtml };
        }
      }
    } catch {
      // keep waiting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
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
  options?: {
    authSource?: BrowserAuthSourceMeta | null;
    usedProfileContext?: boolean;
    preferExistingTab?: boolean;
    method?: string;
    body?: Record<string, unknown> | undefined;
  },
): Promise<{ status: number; data: unknown; trace_id: string; network_events?: Array<{
  startedDateTime: string;
  request: { url: string; method: string; headers: Array<{ name: string; value: string }>; postData?: { mimeType?: string; text?: string } };
  response: { status: number; headers: Array<{ name: string; value: string }>; content?: { mimeType?: string; text?: string } };
  }> }> {
  await acquireTabSlot();
  await kuri.start();
  await kuri.discoverTabs();
  const isDocumentPostFlow = (options?.method ?? "GET").toUpperCase() === "POST" && !!options?.body && typeof options.body === "object";

  let tabId: string | undefined;
  let createdFreshTab = false;
  if (options?.preferExistingTab) {
    const existingTabs = (await kuri.discoverTabs()).filter((tab) => !/^chrome-extension:|^devtools:/.test(tab.url));
    if (existingTabs[0]?.id) {
      tabId = existingTabs[0].id;
    } else {
      try {
        tabId = await kuri.newTab("about:blank");
        createdFreshTab = !!tabId;
        if (!tabId) tabId = await kuri.getDefaultTab();
      } catch {
        tabId = await kuri.getDefaultTab();
      }
    }
  } else {
    try {
      tabId = await kuri.newTab("about:blank");
      createdFreshTab = !!tabId;
      if (!tabId) tabId = await kuri.getDefaultTab();
    } catch {
      tabId = await kuri.getDefaultTab();
    }
  }
  if (!tabId) throw new Error("Failed to acquire browser tab");
  activeTabRegistry.add(tabId);

  try {
    let harStarted = false;
    if (!isDocumentPostFlow) {
      try {
        await kuri.harStart(tabId);
        harStarted = true;
      } catch {
        // best-effort
      }
    }

    // Set headers
    const headers = { ...CLIENT_HINT_HEADERS, ...authHeaders };
    await kuri.setHeaders(tabId, headers);
    await injectCookies(tabId, cookies, new URL(triggerUrl).origin);

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
      if (!isDocumentPostFlow) await kuri.evaluate(tabId, buildInterceptorScript(false));
    } catch { /* best-effort */ }

    // Navigate to the trigger page — the site's JS will make the API call
    await kuri.navigate(tabId, triggerUrl);
    // Re-inject interceptor after navigation
    try {
      if (isDocumentPostFlow) {
        await waitForReadyState(tabId, 8000);
        await waitForTriggerForm(tabId, targetBase);
      } else {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (!isDocumentPostFlow) await kuri.evaluate(tabId, buildInterceptorScript(false));
    } catch { /* page may not be ready */ }

    if ((options?.method ?? "GET").toUpperCase() === "POST" && options?.body && typeof options.body === "object") {
      log("capture", `trigger-and-intercept: submitting POST form to ${targetBase}`);
      const submitState = {
        action: targetUrlPattern,
        payload: options.body,
      };
      await kuri.evaluate(tabId, `window.__unbrowseSubmitState=${JSON.stringify(submitState)};true`);
      await kuri.evaluate(
        tabId,
        `(()=>{const s=window.__unbrowseSubmitState||{},p=s.payload||{},fs=[...document.forms||[]];let f=null,b=-1;for(const x of fs){const a=String(x.action||'');let n=a.includes(s.action)?10:(a.includes('/result-page')?4:0);for(const k of Object.keys(p))if(x.querySelector('[name="'+k+'"]'))n+=2;if(n>b){b=n;f=x}}if(!f){f=document.createElement('form');f.method='POST';f.action=s.action||'';f.style.display='none';document.body.appendChild(f)}f.method='POST';if(s.action)f.action=s.action;const add=(k,v)=>{if(v==null)return;if(Array.isArray(v))return v.forEach((vv)=>add(k,vv));const i=document.createElement('input');i.type='hidden';i.name=k;i.value=String(v);f.appendChild(i)};for(const [k,v] of Object.entries(p)){const els=[...f.querySelectorAll('[name="'+k+'"]')];if(!els.length){add(k,v);continue}for(const el of els){const t=String(el.type||'').toLowerCase(),g=String(el.tagName||'').toLowerCase();if(t==='checkbox'||t==='radio'){const vs=(Array.isArray(v)?v:[v]).map(String);el.checked=vs.includes(String(el.value??'on'));continue}if(g==='select'&&el.multiple&&Array.isArray(v)){const vs=v.map(String);for(const o of [...el.options||[]])o.selected=vs.includes(String(o.value));continue}el.value=Array.isArray(v)?String(v[0]??''):String(v??'')}}window.__unbrowseSubmitMeta={action:f.action,formId:f.id||null,mode:f===fs.find(Boolean)?'existing-form':'synthetic-form'};return true})()`,
      );
      await kuri.evaluate(
        tabId,
        `(()=>{const f=[...document.forms||[]].find((x)=>String(x.action||'')===String(window.__unbrowseSubmitState?.action||''))||document.forms[0];if(typeof window.basicformSubmit==='function'){window.basicformSubmit();return 'basicformSubmit'}if(f){f.submit();return 'submit'}return 'no-form'})()`,
      );
    }

    // Poll for the target response
    const POLL_INTERVAL = 1000;
    const MAX_WAIT = 15000;
    const startTime = Date.now();

    while (Date.now() - startTime < MAX_WAIT) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      if (!isDocumentPostFlow) {
        const intercepted = await collectInterceptedRequests(tabId);
        for (const entry of intercepted) {
          const respUrl = entry.url;
          if (matchesTriggerTargetUrl(respUrl, targetBase, targetQueryId)) {
            let data: unknown = entry.response_body;
            try { data = JSON.parse(entry.response_body ?? ""); } catch { /* keep as string */ }
            log("capture", `trigger-and-intercept: got status ${entry.response_status} for ${targetBase}`);
            return {
              status: entry.response_status,
              data,
              trace_id: nanoid(),
              network_events: [{
                startedDateTime: entry.timestamp,
                request: {
                  url: entry.url,
                  method: entry.method,
                  headers: Object.entries(entry.request_headers ?? {}).map(([name, value]) => ({ name, value: String(value) })),
                  ...(entry.request_body == null ? {} : {
                    postData: {
                      text: entry.request_body,
                    },
                  }),
                },
                response: {
                  status: entry.response_status,
                  headers: Object.entries(entry.response_headers ?? {}).map(([name, value]) => ({ name, value: String(value) })),
                  ...(entry.response_body == null ? {} : {
                    content: {
                      mimeType: entry.content_type,
                      text: entry.response_body,
                    },
                  }),
                },
              }],
            };
          }
        }
      }
      try {
        const currentUrl = await kuri.getCurrentUrl(tabId);
        if (matchesTriggerTargetUrl(currentUrl, targetBase, targetQueryId)) {
          const settledNavigation = await waitForUsableDocumentNavigation(tabId, targetBase, targetQueryId, 5000);
          if (settledNavigation) {
            const { currentUrl: settledUrl, currentHtml } = settledNavigation;
            log("capture", `trigger-and-intercept: detected document navigation ${currentUrl}`);
            return {
              status: 200,
              data: currentHtml,
              trace_id: nanoid(),
              network_events: [{
                startedDateTime: new Date().toISOString(),
                request: {
                  url: settledUrl,
                  method: "GET",
                  headers: [],
                },
                response: {
                  status: 200,
                  headers: [{ name: "content-type", value: "text/html" }],
                  content: {
                    mimeType: "text/html",
                    text: currentHtml,
                  },
                },
              }],
            };
          }
        }
      } catch {
        // keep polling
      }
    }

    log("capture", `trigger-and-intercept: timeout waiting for ${targetBase}`);
    try {
      const settledNavigation = await waitForUsableDocumentNavigation(tabId, targetBase, targetQueryId, 5000);
      if (settledNavigation) {
        const { currentUrl, currentHtml } = settledNavigation;
        log("capture", `trigger-and-intercept: recovered document navigation ${currentUrl}`);
        return {
          status: 200,
          data: currentHtml,
          trace_id: nanoid(),
          network_events: [{
            startedDateTime: new Date().toISOString(),
            request: {
              url: currentUrl,
              method: "GET",
              headers: [],
            },
            response: {
              status: 200,
              headers: [{ name: "content-type", value: "text/html" }],
              content: {
                mimeType: "text/html",
                text: currentHtml,
              },
            },
          }],
        };
      }
    } catch {
      // keep falling through
    }
    if (harStarted) {
      try {
        const { entries } = await kuri.harStop(tabId);
        const matched = entries.find((entry) => {
          const respUrl = entry.request?.url ?? "";
          const baseMatch = respUrl.includes(targetBase);
          const queryIdMatch = !targetQueryId || respUrl.includes(targetQueryId);
          return baseMatch && queryIdMatch;
        });
        if (matched) {
          let data: unknown = matched.response?.content?.text;
          try { data = JSON.parse(matched.response?.content?.text ?? ""); } catch { /* keep text */ }
          log("capture", `trigger-and-intercept: recovered ${targetBase} from HAR`);
          return {
            status: matched.response?.status ?? 0,
            data,
            trace_id: nanoid(),
            network_events: [{
              startedDateTime: matched.startedDateTime,
              request: matched.request,
              response: matched.response,
            }],
          };
        }
      } catch {
        // keep falling through
      }
    }
    if (
      !options?.usedProfileContext &&
      options?.authSource?.family === "chromium" &&
      (cookies.length > 0 || Object.keys(authHeaders ?? {}).length > 0)
    ) {
      try {
        log("capture", `trigger-and-intercept: managed browser replay was insufficient for ${triggerUrl}; retrying with attached ${options.authSource.browserName} profile clone`);
        const profileCtx = await launchChromiumProfileContext(options.authSource);
        const primed = await primeChromiumProfileContext(profileCtx.cdpUrl, cookies, { keepTargetOpen: true });
        await kuri.stop();
        kuri.useExternalChrome(browserCdpBaseUrl(profileCtx.cdpUrl), { child: profileCtx.child, tempDir: profileCtx.tempDir });
        try {
          return await triggerAndIntercept(triggerUrl, targetUrlPattern, [], undefined, {
            ...options,
            usedProfileContext: true,
            preferExistingTab: !!primed.targetId,
          });
        } finally {
          await kuri.stop();
        }
      } catch (attachErr) {
        log("capture", `trigger-and-intercept profile attach failed for ${triggerUrl}: ${attachErr instanceof Error ? attachErr.message : String(attachErr)}`);
      }
    }
    return {
      status: 0,
      data: { error: "trigger_timeout", message: "Target API call not intercepted within 15s" },
      trace_id: nanoid(),
    };
  } finally {
    await cleanupTab(tabId, createdFreshTab);
    releaseTabSlot(tabId);
  }
}
