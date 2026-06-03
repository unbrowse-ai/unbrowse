import * as kuri from "../kuri/client.js";
import { nanoid } from "nanoid";
import { getRegistrableDomain } from "../domain.js";
import { log } from "../logger.js";
import { extractAuthHeaders, extractGraphQLOperationName, isReplayCriticalHeader, isSensitiveHeader } from "../values/header-classify.js";
import { storeCredential } from "../vault/index.js";
import { setLastVendorBlock } from "./process-vendor-signal.js";
import type { BrowserAccessConfig } from "../runtime/browser-access.js";
import { DEFAULT_BROWSER_ACCESS } from "../runtime/browser-access.js";

/**
 * Check whether the current BrowserAccessConfig allows browser-based capture.
 * Returns true when the default or fallback path is "unbrowse" or "direct"
 * (i.e. not proxy-only), meaning we can launch a local browser via Kuri.
 */
export function isBrowserAccessAvailable(
  config: BrowserAccessConfig = DEFAULT_BROWSER_ACCESS,
): boolean {
  return config.default_path !== "proxy" || config.fallback_path !== "proxy";
}

// BUG-GC-012: Use a real Chrome UA — HeadlessChrome is actively blocked by Google and others.
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Tab semaphore: max 3 concurrent capture tabs
const MAX_CONCURRENT_TABS = 3;
let activeTabs = 0;
const waitQueue: Array<() => void> = [];

// Active tab registry — tracked for graceful shutdown
const activeTabRegistry = new Set<string>();

// Tracks tabs where scriptInject has been registered (persistent across navigations)
const interceptorInjectedTabs = new Set<string>();

// Tracks tabs where CDP-level document-start injection has been registered
const cdpDocStartTabs = new Set<string>();

/**
 * Register a script via Chrome's Page.addScriptToEvaluateOnNewDocument CDP method directly.
 * This runs BEFORE any page JS on every navigation — critical for catching early fetch() calls.
 * Falls back silently if CDP is unavailable.
 */
export async function registerDocumentStartScript(tabId: string, source: string): Promise<boolean> {
  if (cdpDocStartTabs.has(tabId)) return true;
  const cdpPort = kuri.getCdpPort();
  if (!cdpPort) return false;

  try {
    // Get the WebSocket URL for this tab
    const resp = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = await resp.json() as Array<{ id: string; webSocketDebuggerUrl?: string }>;
    const target = targets.find((t) => t.id === tabId);
    if (!target?.webSocketDebuggerUrl) return false;

    // Connect via WebSocket and send CDP command
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const result = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { ws.close(); resolve(false); }, 3000);
      ws.onopen = () => {
        ws.send(JSON.stringify({
          id: 1,
          method: "Page.addScriptToEvaluateOnNewDocument",
          params: { source },
        }));
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          if (msg.id === 1) {
            clearTimeout(timeout);
            ws.close();
            resolve(!msg.error);
          }
        } catch { /* ignore parse errors */ }
      };
      ws.onerror = () => { clearTimeout(timeout); ws.close(); resolve(false); };
    });

    if (result) {
      cdpDocStartTabs.add(tabId);
      log("capture", `document-start interceptor registered via direct CDP for tab ${tabId}`);
    }
    return result;
  } catch {
    return false;
  }
}

// Tracks captured request headers from CDP Network events
const cdpCapturedHeaders = new Map<string, Map<string, Record<string, string>>>();

/**
 * Enable CDP Network.requestWillBeSent listener to capture full request headers
 * including auth headers that HAR/interceptor miss. Stores headers indexed by URL.
 */
export async function enableNetworkHeaderCapture(tabId: string): Promise<void> {
  const cdpPort = kuri.getCdpPort();
  if (!cdpPort) return;

  try {
    const resp = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = await resp.json() as Array<{ id: string; webSocketDebuggerUrl?: string }>;
    const target = targets.find((t) => t.id === tabId);
    if (!target?.webSocketDebuggerUrl) return;

    const headers = new Map<string, Record<string, string>>();
    cdpCapturedHeaders.set(tabId, headers);

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.onopen = () => {
      // Enable network domain (may already be enabled, that's OK)
      ws.send(JSON.stringify({ id: 1, method: "Network.enable", params: {} }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.method === "Network.requestWillBeSent") {
          const req = msg.params?.request;
          if (req?.url && req?.headers) {
            // Generic capture policy: if any header on the request is replay-critical
            // (Authorization, x-csrf-*, etc.) or sensitive (per-vendor auth signal),
            // record the request. No URL-pattern hardcoding — the policy lives in
            // reverse-engineer's header classifiers and works for any domain.
            for (const [hk, hv] of Object.entries(req.headers)) {
              if (isReplayCriticalHeader(hk, String(hv ?? "")) || isSensitiveHeader(hk)) {
                headers.set(req.url, req.headers);
                break;
              }
            }
          }
        }
      } catch { /* ignore */ }
    };
    // Keep ws alive — it will be cleaned up when tab closes
    ws.onerror = () => { cdpCapturedHeaders.delete(tabId); };

    log("capture", `CDP network header capture enabled for tab ${tabId}`);
  } catch { /* best-effort */ }
}

/**
 * Get captured request headers for a tab. Returns a map of URL → headers.
 * These come from CDP Network.requestWillBeSent which includes auth headers
 * that HAR and the JS interceptor miss.
 */
export function getCapturedNetworkHeaders(tabId: string): Map<string, Record<string, string>> {
  return cdpCapturedHeaders.get(tabId) ?? new Map();
}

/**
 * Drain CDP-captured request headers for a tab into synthetic RawRequest entries
 * suitable for feeding into extractAuthHeaders. These are NOT real network captures
 * (no response status/body/method beyond the request line) — they exist purely so
 * the existing auth-header extraction pipeline can pick up Authorization / x-csrf-*
 * tokens from XHRs the JS interceptor and HAR missed. Generic by construction —
 * the capture-side filter (isReplayCriticalHeader / isSensitiveHeader) already
 * decided which requests are worth recording; this function just reshapes them.
 */
export function getCapturedNetworkHeadersAsRequests(tabId: string): RawRequest[] {
  const headerMap = cdpCapturedHeaders.get(tabId);
  if (!headerMap || headerMap.size === 0) return [];
  const now = new Date().toISOString();
  const out: RawRequest[] = [];
  for (const [url, hdrs] of headerMap.entries()) {
    out.push({
      url,
      method: "GET",
      request_headers: hdrs,
      response_status: 0,
      response_headers: {},
      timestamp: now,
    });
  }
  return out;
}
// Hard timeout per capture: 90s prevents stuck tabs from holding slots forever.
const CAPTURE_TIMEOUT_MS = 90_000;
const CAPTURE_NAV_TIMEOUT_MS = 20_000;
// No-progress soft-deadline: if the page has fired ZERO network requests after
// this many ms, the SPA has hung (bestbuy + Akamai pattern observed
// 2026-05-09). Bail out early with an empty CaptureResult so
// executeBrowserCapture L1303 SSR fast-path runs with budget remaining
// before the bench wrapper's outer shell SIGTERM (≥60s) fires. Plan-v12
// Phase B.
const CAPTURE_NO_PROGRESS_MS = 30_000;

/**
 * Races `fn()` against an AbortSignal so that each CDP phase exits immediately
 * when the overall capture timeout fires — instead of waiting for kuri's own
 * 30s per-request timeout to expire (which caused 120s+ hangs, bug #113).
 */
export function withBrowserPhaseTimeout<T>(
  signal: AbortSignal,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(`capture phase '${label}' timed out`));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`capture phase '${label}' timed out`));
    signal.addEventListener("abort", onAbort, { once: true });
    fn().then(
      (val) => { signal.removeEventListener("abort", onAbort); resolve(val); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

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

async function openFreshCaptureTab(): Promise<string> {
  const tabId = await kuri.newTab("about:blank");
  if (!tabId) throw new Error("Failed to create a fresh browser tab");
  return tabId;
}

type CaptureNavigationPage = {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
};

export async function navigatePageForCapture(page: CaptureNavigationPage, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: CAPTURE_NAV_TIMEOUT_MS });
}

/**
 * Returns the canonical ordered list of capture setup phases for a given capture context.
 *
 * This is the authoritative ordering contract for captureSession. All network recording
 * setup (scriptInject, addInitScript, harStart, cdpEnable) MUST precede any navigation
 * phase so that requests fired during LinkedIn's challenge redirect chain are captured.
 *
 * Used by tests to verify the ordering invariant without running a real browser.
 */
export function getCaptureSetupOrder(opts: { hasCookies: boolean }): string[] {
  const phases: string[] = [
    "setHeaders",
    "addInitScript",   // Page.addScriptToEvaluateOnNewDocument — runs before page JS on every navigation
    "scriptInject",    // persistent interceptor for fetch/XHR
    "harStart",        // Kuri HAR recording
    "cdpEnable",       // direct CDP Network.enable
  ];
  if (opts.hasCookies) {
    phases.push("navigate:origin");   // first navigation — recording already active
    phases.push("waitForLoad:origin");
    phases.push("injectCookies");
  }
  phases.push("navigate");            // navigate to target URL
  return phases;
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
  if (tabId) { activeTabRegistry.delete(tabId); interceptorInjectedTabs.delete(tabId); }
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
  graph_session?: {
    observed_operations: string[];
    known_bindings: Record<string, unknown>;
    suggested_next: string[];
  };
  // === Harness #2: Visual context for agents ===
  // Screenshots at key capture points. Keys: "pre", "post", "interactions"
  screenshots?: Record<string, string>;
  /** Proof metadata generated during capture, keyed by "METHOD:URL" */
  zk_proofs?: Map<string, import("../types/proof.js").ZkProof>;
  /** Anti-bot localStorage tokens + embedded SSR JSON extracted post-navigation.
   *  Used by execute-time DAG recomputation on difficult sites. */
  page_state?: {
    localStorage?: Record<string, string>;
    embedded_json?: Record<string, unknown>[];
  };
}

export interface RawRequest {
  url: string;
  method: string;
  request_headers: Record<string, string>;
  request_body?: string;
  response_status: number;
  response_headers: Record<string, string>;
  response_body?: string;
  /**
   * True when `response_body` was NOT captured from the wire but fabricated by
   * the substrate purely so an uncaptured-but-API-shaped request survives
   * admission. A fabricated body must never become a response contract
   * (response_schema / proven_recipe) or flip verification_status: the
   * endpoint's real response shape is unknown, not whatever was synthesized.
   */
  synthetic_body?: boolean;
  timestamp: string;
  /** Query hook bridge: which action step triggered this request (#114) */
  triggered_by_step?: number;
  triggered_by_action?: string;
  triggered_by_ref?: string;
}

export interface QueryHookEvent {
  step_index: number;
  action_type: string;
  selector: string;
  requests_triggered: Array<{ url: string; method: string }>;
  timestamp: number;
}

interface ExtensionEntry {
  url: string;
  method: string;
  type: string;       // "xmlhttprequest", "fetch", "main_frame", etc.
  statusCode?: number;
  requestHeaders?: Array<{ name: string; value: string }>;
  responseHeaders?: Array<{ name: string; value: string }>;
  requestBody?: string;
  tabId?: number;
  timestamp: number;
}

interface PerformanceResourceEntry {
  name: string;
  initiatorType?: string;
  transferSize?: number;
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

function shouldRetryEphemeralProfileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /persistentcontext|target page, context or browser has been closed|browser has been closed|page has been closed|fetch failed|econnrefused|connection refused/i.test(message);
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

export function deriveIntentHints(captureUrl?: string, intent?: string): string[] {
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

// Pure decision core of the Phase-4 intent-aware lazy-API wait, issue
// #98 (SPA network-idle: wait for lazy-loaded API calls). Extracted so
// the lazy/late-arrival recognition is deterministically pinnable
// without a live kuri tab. Byte-identical to the prior inline Phase-4
// logic: hint is matched as-written against a lowercased URL, matching
// the original `u.toLowerCase().includes(hint)` semantics.
export function computeWantedHints(
  derivedHints: Iterable<string>,
  capturedUrls: Iterable<string>,
): string[] {
  const captured = [...capturedUrls];
  return [...derivedHints].filter(
    (hint) => !captured.some((u) => u.toLowerCase().includes(hint)),
  );
}

// The first still-wanted hint a (possibly lazily / late-arriving)
// request URL satisfies, or null. Pure; mirrors the Phase-4 poll match
// step exactly so a late API call matching a wanted hint is recognized
// the moment it is intercepted.
export function matchInterceptedToHint(
  entryUrl: string,
  wantedHints: readonly string[],
): string | null {
  const u = entryUrl.toLowerCase();
  return wantedHints.find((hint) => u.includes(hint)) ?? null;
}

// Pure decision core of the noise-aware early-exit for issue #98 (SPA
// network-idle: wait for lazy-loaded API calls). The pre-fix early-exit
// at waitForContentReady fired whenever ANY response body existed; on
// dashboard SPAs that's true within ~1s (HTML shell + bundle JS chunks
// + analytics pings) so the real data XHR firing 2-5s into React
// hydration was never seen. The fix: only declare "captured enough" if
// at least one body is API-shaped per URL pattern. Extracted as a pure
// helper so the regression is deterministically pinnable without a
// live kuri tab.
//
// API_URL_PATTERN mirrors the same constant used by the CDP body
// auto-fetch path at L1509 (kept inline there because that scope owns
// the WebSocket / requestId state machine). If you change one, change
// both; the test suite pins this exact pattern against representative
// URLs from issue #98 (ads.x.com, music.youtube.com).
export const API_URL_PATTERN = /\/api\/|\/graphql|voyager|youtubei|\/v\d+\//i;

export function isApiShapedUrl(url: string): boolean {
  return API_URL_PATTERN.test(url);
}

export function hasApiShapedBody(urls: Iterable<string>): boolean {
  for (const url of urls) {
    if (isApiShapedUrl(url)) return true;
  }
  return false;
}

export type HydrationProbeSnapshot = {
  textLength: number;
  meaningfulElementCount: number;
  mutationCount: number;
  resourceCount: number;
  hasSpaMarker: boolean;
};

export function isNonShellHydratedDom(snapshot: Pick<HydrationProbeSnapshot, "textLength" | "meaningfulElementCount">): boolean {
  return snapshot.textLength >= 200 || snapshot.meaningfulElementCount >= 3;
}

export function shouldStopHydrationWait(
  previous: HydrationProbeSnapshot | null,
  current: HydrationProbeSnapshot,
  quietMs: number,
): boolean {
  if (isNonShellHydratedDom(current)) return true;
  if (!previous) return false;
  const progressed =
    current.textLength > previous.textLength ||
    current.meaningfulElementCount > previous.meaningfulElementCount ||
    current.mutationCount > previous.mutationCount ||
    current.resourceCount > previous.resourceCount;
  if (progressed) return false;
  return quietMs >= 100 && (current.mutationCount > 0 || current.resourceCount > 0);
}

async function readHydrationProbeSnapshot(tabId: string, responseBodies?: Map<string, string>): Promise<HydrationProbeSnapshot | null> {
  try {
    const raw = await kuri.evaluate(tabId, `JSON.stringify((function(){
      var body = document.body;
      var text = body && body.innerText ? body.innerText.replace(/\\s+/g, " ").trim() : "";
      var meaningful = document.querySelectorAll("main article, main section, [role='main'] article, [role='main'] section, [data-testid], [data-test-id]").length;
      var hasSpaMarker = !!(
        document.querySelector("#__NEXT_DATA__, #___gatsby, #root, #app, [data-reactroot], [data-server-rendered]") ||
        Array.prototype.some.call(document.scripts || [], function(s) {
          var t = (s.id || "") + " " + (s.type || "") + " " + (s.textContent || "").slice(0, 2000);
          return /__NUXT__|self\\.__next_f|dehydratedState|__APOLLO_STATE__|__INITIAL_STATE__|application\\/json/i.test(t);
        })
      );
      return {
        textLength: text.length,
        meaningfulElementCount: meaningful,
        mutationCount: Number(window.__unbrowseHydrationMutations || 0),
        resourceCount: performance && performance.getEntriesByType ? performance.getEntriesByType("resource").length : 0,
        hasSpaMarker: hasSpaMarker
      };
    })())`);
    const parsed = JSON.parse(String(raw)) as HydrationProbeSnapshot;
    parsed.resourceCount += responseBodies?.size ?? 0;
    return parsed;
  } catch {
    return null;
  }
}

async function waitForGenericSpaHydration(
  tabId: string,
  responseBodies?: Map<string, string>,
  timeoutMs = 2500,
): Promise<void> {
  const first = await readHydrationProbeSnapshot(tabId, responseBodies);
  if (!first || isNonShellHydratedDom(first) || !first.hasSpaMarker) return;

  try {
    await kuri.evaluate(tabId, `(function(){
      if (window.__unbrowseHydrationObserverInstalled) return;
      window.__unbrowseHydrationObserverInstalled = true;
      window.__unbrowseHydrationMutations = Number(window.__unbrowseHydrationMutations || 0);
      var target = document.documentElement || document;
      new MutationObserver(function(){
        window.__unbrowseHydrationMutations = Number(window.__unbrowseHydrationMutations || 0) + 1;
      }).observe(target, { childList: true, subtree: true, characterData: true });
    })()`);
  } catch {
    return;
  }

  let previous: HydrationProbeSnapshot | null = first;
  let lastProgressAt = Date.now();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    const intercepted = await collectInterceptedRequests(tabId).catch(() => []);
    for (const entry of intercepted) {
      if (entry.response_body && !entry.is_js) responseBodies?.set(entry.url, entry.response_body);
    }
    const current = await readHydrationProbeSnapshot(tabId, responseBodies);
    if (!current) return;
    const progressed =
      !previous ||
      current.textLength > previous.textLength ||
      current.meaningfulElementCount > previous.meaningfulElementCount ||
      current.mutationCount > previous.mutationCount ||
      current.resourceCount > previous.resourceCount;
    if (progressed) lastProgressAt = Date.now();
    if (shouldStopHydrationWait(previous, current, Date.now() - lastProgressAt)) return;
    previous = current;
  }
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
export const INTERCEPTOR_SCRIPT = `(function() {
  if (window.__unbrowse_interceptor_installed) return;
  window.__unbrowse_interceptor_installed = true;
  window.__unbrowse_intercepted = [];
  var MAX_BODY = 2 * 1024 * 1024;
  var MAX_JS_BODY = 2 * 1024 * 1024;
  var MAX_ENTRIES = 2000;

  // Intercept fetch
  var origFetch = window.fetch;
  window.fetch = function() {
    var args = arguments;
    var isRequestObj = args[0] && typeof args[0] === 'object' && typeof args[0].url === 'string';
    var url = typeof args[0] === 'string' ? args[0] : (isRequestObj ? args[0].url : '');
    var opts = args[1] || {};
    // Extract method: prefer explicit opts, then Request object, then default GET
    var method = (opts.method || (isRequestObj ? args[0].method : null) || 'GET').toUpperCase();
    // Extract body: prefer explicit opts.body, then clone+read Request body
    var reqBody = opts.body ? String(opts.body).substring(0, MAX_BODY) : undefined;
    var reqBodyPromise = null;
    if (!reqBody && isRequestObj && method !== 'GET' && method !== 'HEAD') {
      try {
        var reqClone = args[0].clone();
        reqBodyPromise = reqClone.text().then(function(t) { return t ? t.substring(0, MAX_BODY) : undefined; }).catch(function() { return undefined; });
      } catch(e) { /* clone failed */ }
    }
    var reqHeaders = {};
    // Extract headers from Request object (first arg)
    if (isRequestObj && args[0].headers && typeof args[0].headers.forEach === 'function') {
      args[0].headers.forEach(function(v, k) { reqHeaders[k] = v; });
    }
    // Override/merge with explicit opts.headers (second arg)
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
      var isProto = ct.indexOf('protobuf') !== -1 || ct.indexOf('x-protobuf') !== -1;
      var isJs = ct.indexOf('javascript') !== -1 || /\\.js(\\?|$)/.test(url);
      var isData = ct.indexOf('json') !== -1 || isProto ||
                   ct.indexOf('text/plain') !== -1 ||
                   url.indexOf('batchexecute') !== -1 || url.indexOf('/api/') !== -1 ||
                   url.indexOf('graphql') !== -1 || url.indexOf('voyager') !== -1 ||
                   url.indexOf('youtubei') !== -1;
      if (!isJs && !isData) return response;
      if (/\\.(css|woff2?|png|jpg|svg|ico)(\\?|$)/.test(url)) return response;
      var clone = response.clone();
      var bodyPromise = isProto
        ? clone.arrayBuffer().then(function(buf) {
            var bytes = new Uint8Array(buf), s = '', chunk = 0x8000;
            for (var i = 0; i < bytes.length; i += chunk) {
              s += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, i, i + chunk));
            }
            return 'base64:' + btoa(s);
          })
        : clone.text();
      // Resolve request body (from Request object clone) and response body in parallel
      Promise.all([
        bodyPromise,
        reqBodyPromise ? reqBodyPromise : Promise.resolve(reqBody)
      ]).then(function(results) {
        var body = results[0];
        var resolvedReqBody = results[1];
        var limit = isJs ? MAX_JS_BODY : MAX_BODY;
        // For JS bundles, drop the entry entirely if response is too large (not useful)
        if (isJs && body.length > limit) return;
        // For API/GraphQL endpoints: record the entry even if response body is too large.
        // Preserve request_body (contains operationName/doc_id) so GraphQL operations
        // can be correctly deduplicated even when the response body exceeds the limit.
        var respBody = body.length > limit ? '' : body;
        var respHeaders = {};
        response.headers.forEach(function(v, k) { respHeaders[k] = v; });
        window.__unbrowse_intercepted.push({
          url: url,
          method: method,
          request_headers: reqHeaders,
          request_body: resolvedReqBody,
          response_status: response.status,
          response_headers: respHeaders,
          response_body: respBody,
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
      var isProto = ct.indexOf('protobuf') !== -1 || ct.indexOf('x-protobuf') !== -1;
      var isJs = ct.indexOf('javascript') !== -1 || /\\.js(\\?|$)/.test(url);
      var isData = ct.indexOf('json') !== -1 || isProto ||
                   ct.indexOf('text/plain') !== -1 ||
                   url.indexOf('batchexecute') !== -1 || url.indexOf('/api/') !== -1 ||
                   url.indexOf('graphql') !== -1 || url.indexOf('voyager') !== -1 ||
                   url.indexOf('youtubei') !== -1;
      if (!isJs && !isData) return;
      if (/\\.(css|woff2?|png|jpg|svg|ico)(\\?|$)/.test(url)) return;
      var rawRespBody = xhr.responseText || '';
      if (isProto && rawRespBody) {
        try { rawRespBody = 'base64:' + btoa(rawRespBody); } catch(e) {}
      }
      var limit = isJs ? MAX_JS_BODY : MAX_BODY;
      // For JS bundles, drop the entry entirely if response is too large (not useful)
      if (isJs && rawRespBody.length > limit) return;
      // For API/GraphQL: record entry even if response body is too large — preserve
      // request_body (operationName/doc_id) for correct GraphQL deduplication.
      var respBody = rawRespBody.length > limit ? '' : rawRespBody;
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
export async function collectInterceptedRequests(tabId: string): Promise<Array<{
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
 * Inject the interceptor script in chunks to work around kuri's ~1KB evaluate limit.
 * Falls back to scriptInject for persistent injection on new navigations.
 */
export async function injectInterceptor(tabId: string): Promise<void> {
  // Split into setup (globals + fetch) and XHR parts
  const SETUP = `(function(){if(window.__unbrowse_interceptor_installed)return;window.__unbrowse_interceptor_installed=true;window.__unbrowse_intercepted=[];window.__UB_MAX=2*1024*1024;window.__UB_MAX_JS=2*1024*1024;window.__UB_MAX_N=500;})()`;

  const FETCH_PATCH = `(function(){if(!window.__unbrowse_interceptor_installed)return;var M=window.__UB_MAX,MJ=window.__UB_MAX_JS,MN=window.__UB_MAX_N;function B(buf){var bytes=new Uint8Array(buf),s='',ch=32768;for(var i=0;i<bytes.length;i+=ch)s+=String.fromCharCode.apply(null,Array.prototype.slice.call(bytes,i,i+ch));return'base64:'+btoa(s)}var oF=window.fetch;window.fetch=function(){var a=arguments,isR=a[0]&&typeof a[0]==='object'&&typeof a[0].url==='string',u=typeof a[0]==='string'?a[0]:(isR?a[0].url:''),o=a[1]||{},m=(o.method||(isR?a[0].method:null)||'GET').toUpperCase(),rb=o.body?String(o.body).substring(0,M):void 0,rbP=null;if(!rb&&isR&&m!=='GET'&&m!=='HEAD'){try{var rc=a[0].clone();rbP=rc.text().then(function(t){return t?t.substring(0,M):void 0}).catch(function(){return void 0})}catch(e){}}var rh={};if(isR&&a[0].headers&&typeof a[0].headers.forEach==='function')a[0].headers.forEach(function(v,k){rh[k]=v});if(o.headers){if(typeof o.headers.forEach==='function')o.headers.forEach(function(v,k){rh[k]=v});else Object.keys(o.headers).forEach(function(k){rh[k]=o.headers[k]})}return oF.apply(this,a).then(function(r){if(window.__unbrowse_intercepted.length>=MN)return r;var ct=r.headers.get('content-type')||'',isP=ct.indexOf('protobuf')!==-1||ct.indexOf('x-protobuf')!==-1;var isJ=ct.indexOf('javascript')!==-1||/\\.js(\\?|$)/.test(u);var isD=ct.indexOf('json')!==-1||isP||ct.indexOf('text/plain')!==-1||u.indexOf('/api/')!==-1||u.indexOf('graphql')!==-1||u.indexOf('voyager')!==-1;if(!isJ&&!isD)return r;if(/\\.(css|woff2?|png|jpg|svg|ico)(\\?|$)/.test(u))return r;var c=r.clone(),bp=isP?c.arrayBuffer().then(B):c.text();Promise.all([bp,rbP?rbP:Promise.resolve(rb)]).then(function(res){var b=res[0],rrb=res[1];var lim=isJ?MJ:M;if(isJ&&b.length>lim)return;var rb2=b.length>lim?'':b;var rr={};r.headers.forEach(function(v,k){rr[k]=v});window.__unbrowse_intercepted.push({url:u,method:m,request_headers:rh,request_body:rrb,response_status:r.status,response_headers:rr,response_body:rb2,content_type:ct,is_js:isJ,timestamp:new Date().toISOString()})}).catch(function(){});return r}).catch(function(e){throw e})}})()`;

  const XHR_PATCH = `(function(){if(!window.__unbrowse_interceptor_installed)return;var M=window.__UB_MAX,MJ=window.__UB_MAX_JS,MN=window.__UB_MAX_N;var oO=XMLHttpRequest.prototype.open,oS=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.open=function(m,u){this.__ub_m=m;this.__ub_u=u;this.__ub_h={};var oSH=this.setRequestHeader.bind(this);this.setRequestHeader=function(k,v){this.__ub_h[k]=v;oSH(k,v)}.bind(this);return oO.apply(this,arguments)};XMLHttpRequest.prototype.send=function(b){var x=this;x.addEventListener('load',function(){if(window.__unbrowse_intercepted.length>=MN)return;var ct=x.getResponseHeader('content-type')||'',u=x.__ub_u||'',isP=ct.indexOf('protobuf')!==-1||ct.indexOf('x-protobuf')!==-1;var isJ=ct.indexOf('javascript')!==-1||/\\.js(\\?|$)/.test(u);var isD=ct.indexOf('json')!==-1||isP||ct.indexOf('text/plain')!==-1||u.indexOf('/api/')!==-1||u.indexOf('graphql')!==-1||u.indexOf('voyager')!==-1;if(!isJ&&!isD)return;if(/\\.(css|woff2?|png|jpg|svg|ico)(\\?|$)/.test(u))return;var rb=x.responseText||'';if(isP&&rb){try{rb='base64:'+btoa(rb)}catch(e){}}var lim=isJ?MJ:M;if(isJ&&rb.length>lim)return;var rb2=rb.length>lim?'':rb;window.__unbrowse_intercepted.push({url:u,method:(x.__ub_m||'GET').toUpperCase(),request_headers:x.__ub_h||{},request_body:b?String(b).substring(0,M):void 0,response_status:x.status,response_headers:{},response_body:rb2,content_type:ct,is_js:isJ,timestamp:new Date().toISOString()})});return oS.apply(this,arguments)}})()`;

  // Inject in 3 small chunks
  for (const chunk of [SETUP, FETCH_PATCH, XHR_PATCH]) {
    await kuri.evaluate(tabId, chunk).catch(() => {});
  }
}


/**
 * Merge three passive capture data sources into a unified RawRequest list.
 * Priority: JS interceptor (has bodies) > HAR entries > extension observer > responseBodies-only.
 * Deduplicates by URL, keeps the highest-priority version.
 */
export function mergePassiveCaptureData(
  intercepted: Array<{ url: string; method: string; response_body?: string; response_status: number; request_headers: Record<string, string>; response_headers: Record<string, string>; request_body?: string; content_type?: string; is_js?: boolean; timestamp: string }>,
  harEntries: kuri.KuriHarEntry[],
  extensionEntries: ExtensionEntry[],
  responseBodies: Map<string, string>,
  performanceUrls: string[] = [],
): RawRequest[] {
  const seen = new Map<string, RawRequest>();

  // For GraphQL endpoints, extract operationName from request body to differentiate operations
  // Handles X.com URL patterns, Facebook doc_id/fb_api_req_friendly_name,
  // Instagram query_hash, and URL-encoded form bodies
  function graphqlDedup(url: string, requestBody?: string): string {
    if (!/graphql/i.test(url)) return url;
    const opName = extractGraphQLOperationName(url, requestBody);
    if (opName) return `${url}#op=${opName}`;
    return url;
  }

  // Priority 1: JS-intercepted entries (have response bodies)
  for (const entry of intercepted) {
    if (entry.is_js) continue; // skip JS bundles
    const key = graphqlDedup(entry.url, entry.request_body);
    seen.set(key, {
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

  // Priority 2: HAR entries (supplement with responseBodies map)
  // Skip OPTIONS (CORS preflight) — they pollute method attribution
  for (const entry of harEntries) {
    const url = entry.request?.url;
    if (!url) continue;
    if (entry.request.method === "OPTIONS") continue;
    const postBody = entry.request.postData?.text;
    const key = graphqlDedup(url, postBody);
    if (seen.has(key)) continue;
    const reqHeaders: Record<string, string> = {};
    for (const h of entry.request.headers ?? []) reqHeaders[h.name] = h.value;
    const respHeaders: Record<string, string> = {};
    for (const h of entry.response.headers ?? []) respHeaders[h.name] = h.value;
    seen.set(key, {
      url,
      method: entry.request.method,
      request_headers: reqHeaders,
      request_body: postBody,
      response_status: entry.response.status,
      response_headers: respHeaders,
      response_body: responseBodies.get(url) ?? entry.response.content?.text,
      timestamp: entry.startedDateTime,
    });
  }

  // Priority 3: Extension entries (chrome.webRequest — has full auth headers HAR strips)
  for (const entry of extensionEntries) {
    const reqHeaders: Record<string, string> = {};
    for (const h of entry.requestHeaders ?? []) reqHeaders[h.name] = h.value;
    const respHeaders: Record<string, string> = {};
    for (const h of entry.responseHeaders ?? []) respHeaders[h.name] = h.value;

    const dedupKey = graphqlDedup(entry.url, entry.requestBody);

    // Find any existing entry for this URL (may have GraphQL-suffixed key)
    let merged = false;
    for (const [key, existing] of seen) {
      if (existing.url === entry.url || key === dedupKey) {
        for (const [k, v] of Object.entries(reqHeaders)) {
          if (!existing.request_headers[k]) existing.request_headers[k] = v;
        }
        // Backfill request_body if the existing entry is missing it
        if (!existing.request_body && entry.requestBody) {
          existing.request_body = entry.requestBody;
        }
        merged = true;
        break;
      }
    }
    if (merged) continue;
    seen.set(dedupKey, {
      url: entry.url,
      method: entry.method,
      request_headers: reqHeaders,
      request_body: entry.requestBody,
      response_status: entry.statusCode ?? 0,
      response_headers: respHeaders,
      response_body: responseBodies.get(entry.url),
      timestamp: new Date(entry.timestamp).toISOString(),
    });
  }

  // Priority 4: responseBodies-only entries (from Performance API replay / HAR replay)
  // These URLs have bodies but weren't in HAR, interceptor, or extension data
  for (const perfUrl of performanceUrls) {
    if (seen.has(perfUrl) || responseBodies.has(perfUrl)) continue;
    seen.set(perfUrl, {
      url: perfUrl,
      method: "GET",
      request_headers: {},
      response_status: 200,
      response_headers: {},
      timestamp: new Date().toISOString(),
    });
  }

  // Priority 5: responseBodies-only entries (from Performance API replay / HAR replay)
  // These URLs have bodies but weren't in HAR, interceptor, extension, or synthetic perf data
  for (const [bodyUrl, body] of responseBodies) {
    if (seen.has(bodyUrl)) continue;
    seen.set(bodyUrl, {
      url: bodyUrl,
      method: "GET",
      request_headers: {},
      response_status: 200,
      response_headers: {},
      response_body: body,
      timestamp: new Date().toISOString(),
    });
  }

  return Array.from(seen.values());
}

function appendInterceptedResponseBodies(
  entries: Array<{ url: string; response_body?: string; is_js?: boolean }>,
  responseBodies: Map<string, string>,
): void {
  for (const entry of entries) {
    if (!entry.response_body || entry.is_js) continue;
    responseBodies.set(entry.url, entry.response_body);
  }
}

function normalizeCapturedUrl(url: string, baseUrl?: string): string {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    // Rewrite localhost/127.0.0.1 URLs to the page origin — service workers and dev
    // proxies use local ports but the real API lives on the same origin as the page.
    if (baseUrl && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")) {
      const pageOrigin = new URL(baseUrl).origin;
      return `${pageOrigin}${parsed.pathname}${parsed.search}`;
    }
    return parsed.toString();
  } catch {
    if (!baseUrl) return url;
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      return url;
    }
  }
}

const REPLAY_SKIP = /\.(js|css|woff2?|png|jpe?g|gif|svg|ico|webp|avif|map|ttf)(\?|$)/i;
const HAR_REPLAY_CT = /application\/json|text\/plain|\+json/i;

function isSameOriginUrl(url: string, captureUrl?: string): boolean {
  if (!captureUrl) return false;
  try {
    return new URL(url).origin === new URL(captureUrl).origin;
  } catch {
    return false;
  }
}

export function isReplayableApiUrl(url: string): boolean {
  const normalized = normalizeCapturedUrl(url).toLowerCase();
  if (!normalized || REPLAY_SKIP.test(normalized)) return false;
  if (/\/manifest\.json([?#]|$)/.test(normalized)) return false;
  if (/cloudflareinsights|cdn-cgi\/rum|sentry\.io|piwik|analytics|disqus|doubleclick|googletagmanager|google-analytics/.test(normalized)) return false;
  if (/\/api\//.test(normalized)) return true;
  if (/graphql|voyager|_search/.test(normalized)) return true;
  if (/\/v\d+(?:[./]|\/)/.test(normalized)) return true;
  try {
    const parsed = new URL(normalized);
    if (/^api\./.test(parsed.hostname) && parsed.pathname.endsWith(".json")) return true;
  } catch {
    // ignore bad URL
  }
  if (/(\?|&)format=json(?:&|$)/.test(normalized) || /(\?|&)output=json(?:&|$)/.test(normalized)) return true;
  return false;
}

export function selectPerformanceReplayCandidates(
  entries: PerformanceResourceEntry[],
  params: {
    captureUrl?: string;
    intent?: string;
    knownUrls?: Iterable<string>;
    limit?: number;
  },
): string[] {
  const knownUrls = new Set(params.knownUrls ?? []);
  const wantedHints = new Set(deriveIntentHints(params.captureUrl, params.intent));
  const scored = new Map<string, number>();

  for (const entry of entries) {
    const perfUrl = normalizeCapturedUrl(entry.name, params.captureUrl);
    if (!perfUrl || knownUrls.has(perfUrl) || REPLAY_SKIP.test(perfUrl)) continue;

    const lower = perfUrl.toLowerCase();
    const initiator = (entry.initiatorType ?? "").toLowerCase();
    const apiLike = isReplayableApiUrl(perfUrl);
    const hintMatch = [...wantedHints].some((hint) => lower.includes(hint));
    const initiatorEligible =
      initiator === "fetch" ||
      initiator === "xmlhttprequest" ||
      (initiator === "link" && apiLike);
    if (!initiatorEligible && !apiLike) continue;

    let score = 0;
    if (hintMatch) score += 10;
    if (initiator === "fetch" || initiator === "xmlhttprequest") score += 5;
    if (initiator === "link") score += 2;
    if (apiLike) score += 6;
    if (isSameOriginUrl(perfUrl, params.captureUrl)) score += 2;
    if (/\.json([?#]|$)/.test(lower)) score += 2;
    if (/\/v\d+(?:[./]|\/)/.test(lower)) score += 2;
    if (score <= 0) continue;

    scored.set(perfUrl, Math.max(scored.get(perfUrl) ?? 0, score));
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, params.limit ?? 30)
    .map(([url]) => url);
}

async function collectPerformanceResourceEntries(tabId: string): Promise<PerformanceResourceEntry[]> {
  const perfRaw = await kuri.evaluate(tabId, `JSON.stringify(
    performance.getEntriesByType('resource')
      .map(function(e) { return { name: e.name, initiatorType: e.initiatorType, transferSize: e.transferSize || 0 }; })
  )`);
  if (typeof perfRaw !== "string" || !perfRaw.startsWith("[")) return [];
  const perfEntries: PerformanceResourceEntry[] = JSON.parse(perfRaw);
  return perfEntries.filter((entry) => typeof entry?.name === "string" && entry.name.length > 0);
}

async function replayPerformanceApiResponses(
  tabId: string,
  perfEntries: PerformanceResourceEntry[],
  responseBodies: Map<string, string>,
  captureUrl?: string,
  intent?: string,
): Promise<string[]> {
  const perfUrls = selectPerformanceReplayCandidates(perfEntries, {
    captureUrl,
    intent,
    knownUrls: responseBodies.keys(),
    limit: 30,
  });
  if (perfUrls.length === 0) return [];

  log("capture", `Performance API selected ${perfUrls.length} replayable resource URLs`);
  // Parallel fetch — sequential awaits previously made enrich-capture 6-14s
  // for close-with-many-XHRs sessions. Each XHR is a separate kuri.evaluate
  // round-trip; no inter-dependency, so Promise.allSettled is safe. Per-call
  // failure is already non-fatal; cap and dedup against responseBodies stay.
  const todo = perfUrls.filter((perfUrl) => !responseBodies.has(perfUrl));
  let replayCount = 0;
  await Promise.allSettled(todo.map(async (perfUrl) => {
    try {
      const body = await kuri.evaluate(
        tabId,
        `(function(){var x=new XMLHttpRequest();x.open('GET','${perfUrl.replace(/'/g, "\\'")}',false);x.send();return x.status>=200&&x.status<400?x.responseText:''})()`,
      );
      if (typeof body === "string" && body.length > 0 && body.length < 512 * 1024) {
        responseBodies.set(perfUrl, body);
        replayCount++;
        log("capture", `replay-fetched ${perfUrl.substring(0, 80)} (${body.length}B)`);
      }
    } catch {
      // non-fatal
    }
  }));

  if (replayCount > 0) {
    log("capture", `replay-fetched ${replayCount} API response bodies via Performance API`);
  }
  return perfUrls;
}

async function replayHarApiResponses(
  tabId: string,
  harEntries: kuri.KuriHarEntry[],
  responseBodies: Map<string, string>,
): Promise<void> {
  // Sequential await per HAR entry previously dominated close enrich-capture
  // duration (up to 20 entries × ~hundreds-of-ms each kuri.evaluate). The
  // filter+cap is preserved exactly; only the per-entry await loop is now
  // parallelized via Promise.allSettled. Per-call failure stays non-fatal.
  const candidates: Array<{ url: string; method: string; postData?: string }> = [];
  for (const entry of harEntries) {
    const harUrl = entry.request?.url;
    if (!harUrl || responseBodies.has(harUrl)) continue;
    if (REPLAY_SKIP.test(harUrl)) continue;
    const method = entry.request?.method?.toUpperCase() ?? "GET";
    if (method === "OPTIONS" || method === "HEAD") continue;
    const status = entry.response?.status ?? 0;
    if (status < 200 || status >= 400) continue;
    const ct = (entry.response?.headers ?? []).find((header: { name: string }) => header.name.toLowerCase() === "content-type")?.value ?? "";
    if (!HAR_REPLAY_CT.test(ct) && !harUrl.includes("/api/") && !harUrl.includes("_search") && !harUrl.includes("graphql") && !harUrl.includes("voyager")) continue;
    if (candidates.length >= 20) break;
    const postData = method !== "GET" ? entry.request?.postData?.text : undefined;
    candidates.push({ url: harUrl, method, postData });
  }
  if (candidates.length === 0) return;

  let harReplayCount = 0;
  await Promise.allSettled(candidates.map(async ({ url, method, postData }) => {
    try {
      const replayScript = method === "GET" || !postData
        ? `(function(){var x=new XMLHttpRequest();x.open('GET','${url.replace(/'/g, "\\'")}',false);x.send();return x.status>=200&&x.status<400?x.responseText:''})()`
        : `(function(){var x=new XMLHttpRequest();x.open('${method}','${url.replace(/'/g, "\\'")}',false);x.setRequestHeader('Content-Type','application/json');x.send(${JSON.stringify(postData)});return x.status>=200&&x.status<400?x.responseText:''})()`;
      const body = await kuri.evaluate(tabId, replayScript);
      if (typeof body === "string" && body.length > 0 && body.length < 512 * 1024) {
        responseBodies.set(url, body);
        harReplayCount++;
        log("capture", `har-replay-fetched ${url.substring(0, 80)} (${body.length}B)`);
      }
    } catch {
      // non-fatal
    }
  }));

  if (harReplayCount > 0) {
    log("capture", `har-replay-fetched ${harReplayCount} API response bodies from HAR entries`);
  }
}

export async function enrichPassiveCaptureRequests(params: {
  tabId: string;
  captureUrl: string;
  harEntries: kuri.KuriHarEntry[];
  intent?: string;
  // When true, skip waitForContentReady's first-capture settle (up to ~1s
  // initial + 5s readyState + 8s intent-aware poll). That wait exists to give
  // a freshly-navigated SPA time to fire its XHRs on a ONE-SHOT capture
  // (close/sync). The periodic streaming checkpoint re-enters this function
  // every STREAMING_INTERVAL_MS on the SAME long-lived tab; paying the full
  // wait every tick means a no-API page burns ~8.3s out of every 10s forever
  // (proven via scope=streaming phase=tick dur traces). A periodic snapshot
  // must only enrich what is ALREADY captured; the thorough wait stays on the
  // one-shot close/sync path. Caller-declared, default false (no behavior
  // change for close/sync).
  skipContentReadyWait?: boolean;
}): Promise<RawRequest[]> {
  const { tabId, captureUrl, harEntries, intent, skipContentReadyWait } = params;
  const responseBodies = new Map<string, string>();
  const perfEntries = await collectPerformanceResourceEntries(tabId).catch(() => []);

  let intercepted = await collectInterceptedRequests(tabId).catch(() => []);
  appendInterceptedResponseBodies(intercepted, responseBodies);

  if (!skipContentReadyWait && intercepted.length === 0 && harEntries.length === 0) {
    await waitForContentReady(tabId, captureUrl, intent, responseBodies).catch(() => {});
    intercepted = await collectInterceptedRequests(tabId).catch(() => intercepted);
    appendInterceptedResponseBodies(intercepted, responseBodies);
  }

  const performanceUrls = await replayPerformanceApiResponses(tabId, perfEntries, responseBodies, captureUrl, intent).catch(() => []);
  await replayHarApiResponses(tabId, harEntries, responseBodies).catch(() => {});

  const extensionEntries = await collectExtensionRequests(tabId).catch(() => []);
  const requests = mergePassiveCaptureData(intercepted, harEntries, extensionEntries, responseBodies, performanceUrls).map((request) => ({
    ...request,
    url: normalizeCapturedUrl(request.url, captureUrl),
  }));

  // HAR strips auth headers. Infer their presence from cookies so
  // enrichEndpointsWithTokenSources can create DAG bindings.
  if (extensionEntries.length === 0) {
    const tabCookies = await kuri.getCookies(tabId).catch(() => []) as Array<{ name: string; value: string }>;
    const hasAuthCookie = tabCookies.some((c) => /^(ct0|csrf_token|_csrf|csrftoken|XSRF-TOKEN|auth_token)$/i.test(c.name));
    if (hasAuthCookie) {
      for (const req of requests) {
        if (/\/(api|graphql|v\d+)\b/i.test(req.url) || /ads-api|voyager/i.test(req.url)) {
          if (!req.request_headers["authorization"]) req.request_headers["authorization"] = "[REDACTED]";
          if (!req.request_headers["x-csrf-token"]) req.request_headers["x-csrf-token"] = "[REDACTED]";
        }
      }
    }
  }

  log("capture", `browse-checkpoint tracked ${harEntries.length} HAR, ${intercepted.length} intercepted, ${extensionEntries.length} extension, ${responseBodies.size} bodies → ${requests.length} merged`);
  return requests;
}
/**
 * Collect network requests observed by kuri's builtin extension (chrome.webRequest).
 * Gracefully returns [] if the extension relay is not yet wired.
 */
async function collectExtensionRequests(tabId: string): Promise<ExtensionEntry[]> {
  try {
    const raw = await kuri.evaluate(tabId, `
      (function() {
        if (!window.__kuri || !window.__kuri._networkLog) return '[]';
        var log = window.__kuri._networkLog;
        window.__kuri._networkLog = [];
        return JSON.stringify(log);
      })()
    `);
    if (typeof raw !== "string" || !raw.startsWith("[")) return [];
    const entries: ExtensionEntry[] = JSON.parse(raw);
    log("capture", `extension observer: ${entries.length} entries collected`);
    return entries;
  } catch {
    log("capture", "extension observer: not available (expected if relay not wired)");
    return [];
  }
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
  await new Promise((r) => setTimeout(r, 1000));

  // Early exit: only bail when at least one captured body is API-shaped.
  // Pre-fix this fired whenever responseBodies.size>0, which on dashboard
  // SPAs is true within ~1s (HTML shell, bundle JS chunks, analytics
  // pings); the real data XHR firing 2-5s into React hydration was
  // never seen. See issue #98 (SPA network-idle: wait for lazy-loaded
  // API calls) for the full trace. isApiShapedUrl uses the same
  // API_URL_PATTERN the CDP auto-fetch path uses.
  if (responseBodies && hasApiShapedBody(responseBodies.keys())) {
    log("capture", `early exit: ${responseBodies.size} API responses already captured during navigation`);
    // Brief extra settle to catch any trailing responses
    await new Promise((r) => setTimeout(r, 500));
    return;
  }

  // Phase 2: Cloudflare challenge detection and wait
  try {
    const hasCf = await kuri.hasCloudflareChallenge(tabId);
    if (hasCf) {
      log("capture", "Cloudflare challenge detected, waiting for clearance...");
      // Day-6 W1: record vendor signal for cli_timeout envelope path.
      // If we time out before clearance, the CLI surfaces this as a
      // browser_block_signals:["vendor:cloudflare"] envelope instead
      // of a bare cli_timeout error.
      try {
        const host = captureUrl ? new URL(captureUrl).hostname : tabId;
        setLastVendorBlock("cloudflare", host);
      } catch {
        setLastVendorBlock("cloudflare", tabId);
      }
      const cleared = await kuri.waitForCloudflare(tabId, 15000);
      if (cleared) {
        log("capture", "Cloudflare cleared");
      }
    }
  } catch {
    // Tab not available — skip CF detection
  }

  // Phase 3: Wait for document ready state (replaces networkidle)
  await waitForReadyState(tabId, 5000);

  // Phase 3b: Generic SPA hydration wait. Shell-like Next/Nuxt/React pages
  // often report readyState=complete before their first useful DOM mutation or
  // lazy XHR. Wait until the DOM is no longer shell-only, or until mutations /
  // resource counts have been quiet for one poll tick.
  await waitForGenericSpaHydration(tabId, responseBodies);

  // Early exit: check again after readyState — SPAs often fire API calls during hydration
  if (responseBodies) {
    const intercepted = await collectInterceptedRequests(tabId);
    for (const entry of intercepted) {
      if (entry.response_body && !entry.is_js) {
        responseBodies.set(entry.url, entry.response_body);
      }
    }
    if (hasApiShapedBody(responseBodies.keys())) {
      log("capture", `early exit after readyState: ${responseBodies.size} API responses captured`);
      return;
    }
  }

  // Phase 4: Intent-aware API wait — poll intercepted requests for matching API URLs
  if (captureUrl && responseBodies) {
    const derivedHints = new Set(deriveIntentHints(captureUrl, intent));
    const wantedHints = computeWantedHints(derivedHints, responseBodies.keys());
    if (wantedHints.length > 0) {
      log("capture", `intent-aware wait: looking for API matching one of [${wantedHints.join(", ")}] (from ${captureUrl})`);
      const intentStart = Date.now();
      const INTENT_MAX_WAIT = 8000;
      const INTENT_POLL_INTERVAL = 1000;
      while (Date.now() - intentStart < INTENT_MAX_WAIT) {
        await new Promise((r) => setTimeout(r, INTENT_POLL_INTERVAL));
        // Check newly intercepted requests
        const intercepted = await collectInterceptedRequests(tabId);
        for (const entry of intercepted) {
          const matchedHint = matchInterceptedToHint(entry.url, wantedHints);
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
        await new Promise((r) => setTimeout(r, 1500));
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

  // Guard: check browser access config before launching
  if (!isBrowserAccessAvailable()) {
    releaseTabSlot("no-tab");
    throw new Error("Browser access is not available (proxy-only config)");
  }

  // Ensure Kuri is running and tabs are discovered
  await kuri.start();
  await kuri.discoverTabs(); // Sync Chrome tabs into Kuri's registry

  let tabId: string;
  try {
    tabId = await openFreshCaptureTab();
  } catch (error) {
    releaseTabSlot("no-tab");
    throw error;
  }
  activeTabRegistry.add(tabId);

  const domain = new URL(url).hostname;
  let captureTimedOut = false;
  // No-progress soft-deadline flag (Plan-v12 Phase B). Distinct from
  // captureTimedOut: this fires earlier (30s) and only when ZERO network
  // activity has been observed. Unlike captureTimedOut, it does NOT throw —
  // we want the empty-state CaptureResult to flow through executeBrowserCapture
  // so its existing L1303 SSR fast-path call site picks up the rescue.
  let noProgressBail = false;
  let retryFreshTab = false;
  let captureError: unknown;
  let pageState: CaptureResult["page_state"];
  const abortController = new AbortController();
  const { signal } = abortController;
  // phase() races each CDP call against the overall capture timeout (bug #113 fix)
  const phase = <T>(label: string, fn: () => Promise<T>) =>
    withBrowserPhaseTimeout(signal, label, fn);
  const timeoutHandle = setTimeout(() => {
    captureTimedOut = true;
    abortController.abort();
    resetTab(tabId).catch(() => {});
  }, CAPTURE_TIMEOUT_MS);
  // Function-scope so the finally block (~L1893) can clearTimeout it even if
  // the try block throws before reaching the assignment site.
  let noProgressHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    // Set headers: client hints + auth headers
    const allHeaders = { ...CLIENT_HINT_HEADERS, ...(authHeaders ?? {}) };
    await phase("setHeaders", () => kuri.setHeaders(tabId, allHeaders));

    // Fix for issue #403: all network recording setup must happen BEFORE any navigation.
    // LinkedIn (and similar sites with challenge/redirect chains) fire Voyager GraphQL
    // API calls during the origin navigation — setting up recording after the first
    // navigate call means those requests are never captured.

    // Step 1: Register interceptor via addInitScript — runs before page JS on EVERY
    // navigation including LinkedIn's challenge redirect chain. This is the most
    // reliable hook for catching early API calls on SPAs with redirect flows.
    try {
      await phase("addInitScript", () => kuri.addInitScript(tabId, INTERCEPTOR_SCRIPT));
      log("capture", "interceptor registered via addInitScript (pre-navigation, survives redirects)");
    } catch {
      // Older kuri builds without addInitScript — fall through to scriptInject
      log("capture", "addInitScript unavailable — falling back to scriptInject");
    }

    // Step 2: scriptInject — also registers as Page.addScriptToEvaluateOnNewDocument.
    // Belt-and-suspenders: use both addInitScript and scriptInject for maximum coverage.
    if (!interceptorInjectedTabs.has(tabId)) {
      try {
        await phase("scriptInject", () => kuri.scriptInject(tabId, INTERCEPTOR_SCRIPT));
        interceptorInjectedTabs.add(tabId);
        log("capture", "interceptor installed via scriptInject (persistent)");
      } catch {
        // Fallback for older kuri versions without scriptInject
        log("capture", "scriptInject unavailable — falling back to evaluate injection");
      }
    }

    // Step 3: Start HAR recording BEFORE any navigation.
    try { await phase("harStart", () => kuri.harStart(tabId)); } catch { /* harStart may fail */ }

    // Step 4: Direct CDP network capture — BEFORE any navigation.
    // This is the primary capture path for LinkedIn Voyager and similar SPA APIs.
    const cdpNetworkEntries: kuri.KuriHarEntry[] = [];
    const cdpRequestMap = new Map<string, { method: string; url: string; headers: Array<{name: string; value: string}>; postData?: string }>();
    // No-progress watchdog (Plan-v12 Phase B). Inspects cdpRequestMap.size at
    // fire-time. cdpRequestMap is populated continuously by Network.requestWillBeSent
    // events, so it's the earliest signal that the page is doing ANY network
    // activity. If the page is hung (bestbuy SPA pattern), this fires at 30s
    // and aborts so the orchestrator's existing SSR fast-path runs with budget
    // remaining before the bench's outer shell SIGTERM (≥60s).
    noProgressHandle = setTimeout(() => {
      if (cdpRequestMap.size === 0) {
        noProgressBail = true;
        captureTimedOut = true;  // route through existing throw/abort plumbing
        abortController.abort();
        resetTab(tabId).catch(() => {});
        log("capture", `no_progress_bail: 0 CDP requests after ${CAPTURE_NO_PROGRESS_MS}ms — aborting for SSR rescue`);
      }
    }, CAPTURE_NO_PROGRESS_MS);
    const cdpResponseMeta = new Map<string, { status: number; headers: Array<{name: string; value: string}>; mimeType: string }>();
    const cdpFinishedRequests = new Set<string>();
    let cdpWs: WebSocket | null = null;
    let cdpMsgId = 10;
    const cdpPendingBodies = new Map<number, string>(); // msgId -> requestId
    const cdpResolvedBodies = new Map<string, string>(); // url -> body
    try {
      const cdpPort = kuri.getCdpPort();
      if (cdpPort) {
        const tabsResp = await fetch(`http://127.0.0.1:${cdpPort}/json`);
        const tabs = (await tabsResp.json()) as Array<{ id: string; webSocketDebuggerUrl?: string; type?: string }>;
        const cdpTab = tabs.find(t => t.id === tabId) ?? tabs.find(t => t.type === "page");
        if (cdpTab?.webSocketDebuggerUrl) {
          cdpWs = new WebSocket(cdpTab.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            cdpWs!.onopen = () => resolve();
            cdpWs!.onerror = () => reject(new Error("CDP WS failed"));
            setTimeout(() => reject(new Error("CDP WS timeout")), 3000);
          });
          cdpWs.onmessage = (ev) => {
            try {
              const msg = JSON.parse(String(ev.data));
              if (msg.method === "Network.requestWillBeSent") {
                const p = msg.params;
                const reqHeaders = Object.entries(p.request?.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
                cdpRequestMap.set(p.requestId, {
                  method: p.request?.method ?? "GET",
                  url: p.request?.url ?? "",
                  headers: reqHeaders,
                  postData: p.request?.postData,
                });
              } else if (msg.method === "Network.responseReceived") {
                const p = msg.params;
                const respHeaders = Object.entries(p.response?.headers ?? {}).map(([name, value]) => ({ name, value: String(value) }));
                cdpResponseMeta.set(p.requestId, {
                  status: p.response?.status ?? 0,
                  headers: respHeaders,
                  mimeType: p.response?.mimeType ?? "",
                });
              } else if (msg.method === "Network.loadingFinished") {
                const requestId = msg.params?.requestId;
                cdpFinishedRequests.add(requestId);
                const req = cdpRequestMap.get(requestId);
                const resp = cdpResponseMeta.get(requestId);
                // Auto-fetch response body for API-like URLs
                if (req && resp && API_URL_PATTERN.test(req.url) && (resp.mimeType.includes("json") || resp.mimeType.includes("text"))) {
                  const id = ++cdpMsgId;
                  cdpPendingBodies.set(id, req.url);
                  cdpWs!.send(JSON.stringify({ id, method: "Network.getResponseBody", params: { requestId } }));
                }
              } else if (msg.id && cdpPendingBodies.has(msg.id)) {
                // Response to getResponseBody
                const reqUrl = cdpPendingBodies.get(msg.id)!;
                cdpPendingBodies.delete(msg.id);
                if (msg.result?.body) {
                  cdpResolvedBodies.set(reqUrl, msg.result.body);
                }
              }
            } catch { /* parse error — ignore */ }
          };
          // cdpEnable: must happen before first navigate (issue #403)
          cdpWs.send(JSON.stringify({ id: 1, method: "Network.enable", params: {} }));
          // Force fresh network fetches so SPA HTTP cache + service workers
          // cannot hide API calls from the interceptor (issue #62).
          // setCacheDisabled disables memory+disk HTTP cache; setBypassServiceWorker
          // forces requests to skip SW fetch handlers. Both apply only while this
          // CDP session is attached, so normal user browsing is unaffected.
          cdpWs.send(JSON.stringify({ id: 2, method: "Network.setCacheDisabled", params: { cacheDisabled: true } }));
          cdpWs.send(JSON.stringify({ id: 3, method: "Network.setBypassServiceWorker", params: { bypass: true } }));
          await new Promise(r => setTimeout(r, 200));
          log("capture", "CDP network capture enabled (direct websocket, pre-navigation, cache+SW bypassed)");
        }
      }
    } catch { /* CDP direct capture is best-effort */ }

    // Step 5: Navigate to origin so cookies bind to the correct domain context.
    // All recording is now active before this point — API calls during LinkedIn's
    // challenge redirect will be captured by addInitScript + CDP.
    if (cookies && cookies.length > 0) {
      const origin = new URL(url).origin;
      await phase("navigate:origin", () => kuri.navigate(tabId, origin));
      await phase("waitForLoad:origin", () => kuri.waitForLoad(tabId, 10_000).catch(() => {}));

      // Check if browser already has a valid session (not redirected to login).
      // If so, skip vault cookie injection — browser cookies are fresher and
      // injecting stale vault cookies (e.g. JSESSIONID) causes HTTP 400.
      const postOriginUrl = await phase("checkOriginUrl", () => kuri.getCurrentUrl(tabId));
      const LOGIN_PATHS_RE = /\/(login|signin|sign-in|sso|auth|uas\/login|checkpoint|oauth)/i;
      const originHost = new URL(origin).hostname;
      let browserAlreadyAuthed = false;
      try {
        const postHost = new URL(postOriginUrl).hostname;
        browserAlreadyAuthed = postHost === originHost && !LOGIN_PATHS_RE.test(new URL(postOriginUrl).pathname);
      } catch { /* bad URL — inject cookies as fallback */ }

      if (browserAlreadyAuthed) {
        log("capture", `browser already authenticated at ${postOriginUrl} — skipping vault cookie injection`);
      } else {
        await phase("injectCookies", () => injectCookies(tabId, cookies!));
      }
    }

    // Determine page domain for JS bundle filtering
    let pageDomain: string | undefined;
    try { pageDomain = getRegistrableDomain(new URL(url).hostname); } catch { /* bad url */ }

    // Navigate to target URL
    await phase("navigate", () => kuri.navigate(tabId, url));

    // === Harness #2: Pre-capture screenshot (what the page looks like before JS execution) ===
    const screenshots: Record<string, string> = {};
    try {
      screenshots.pre = await phase("screenshot:pre", () => kuri.screenshot(tabId));
      log("capture", "pre-capture screenshot taken");
    } catch { /* screenshot may fail, continue */ }

    // Re-inject via evaluate as a last resort for sites that clear window globals
    // (some challenge pages wipe the window object). addInitScript above handles
    // the normal case; this evaluate is a safety net for post-navigation state.
    if (!interceptorInjectedTabs.has(tabId)) {
      await phase("evaluate:interceptor", () => kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {}));
      log("capture", "interceptor re-injected via evaluate fallback");
    }

    // Build response bodies map from intercepted requests
    const responseBodies = new Map<string, string>();
    const jsBundleBodies = new Map<string, string>();
    const MAX_JS_BUNDLES = 20;

    // Helper: drain intercepted data into responseBodies/jsBundleBodies
    const drainIntercepted = async () => {
      try {
        const entries = await collectInterceptedRequests(tabId);
        for (const entry of entries) {
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
        return entries;
      } catch { return []; }
    };

    // Adaptive wait: handle Cloudflare challenges + SPA content loading + intent-aware API wait
    await phase("waitForContentReady", () => waitForContentReady(tabId, url, intent, responseBodies));

    // === Harness #2: Post-load screenshot (what the page looks like after JS renders) ===
    try {
      screenshots.post = await phase("screenshot:post", () => kuri.screenshot(tabId));
      log("capture", "post-capture screenshot taken");
    } catch { /* screenshot may fail, continue */ }

    // Incremental collection: drain intercepted data after content ready
    await drainIntercepted();

    // Collect all intercepted requests (final sweep)
    const intercepted = await phase("collectIntercepted", () => collectInterceptedRequests(tabId));
    const extensionEntries = await phase("collectExtension", () => collectExtensionRequests(tabId));

    // Separate JS bundles from data responses (from final sweep)
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

    // --- Performance API discovery + sync XHR replay ---
    // The JS interceptor can miss early requests (SPA API calls fire before injection).
    // HAR captures URLs but not always bodies.
    // Use Performance API to discover replayable API URLs, including API-ish preloads.
    let performanceUrls: string[] = [];
    try {
      const perfEntries = await phase("evaluate:perf", () => collectPerformanceResourceEntries(tabId));
      performanceUrls = await phase("replay-fetch", () =>
        replayPerformanceApiResponses(tabId, perfEntries, responseBodies, url, intent),
      );
    } catch { /* non-fatal */ }

    // --- Early auth extraction from CDP data ---
    // Store auth headers NOW before harStop can crash and abort the session.
    // CDP request headers include csrf-token, authorization, etc.
    if (cdpRequestMap.size > 0) {
      try {
        const cdpRawReqs = [...cdpRequestMap.values()].map(r => ({
          url: r.url, method: r.method,
          request_headers: Object.fromEntries(r.headers.map(h => [h.name.toLowerCase(), h.value])),
          response_status: 200, response_headers: {}, response_body: undefined, timestamp: "",
        }));
        const authHeaders = extractAuthHeaders(cdpRawReqs);
        if (Object.keys(authHeaders).length > 0) {
          // Merge with existing vault data — pull cookies from auth:{domain} (login flow)
          const rawKey = `${domain}-session`;
          const { getCredential } = await import("../vault/index.js");
          let existing: { cookies?: unknown[]; headers?: Record<string, string> } = {};
          try {
            const stored = await getCredential(rawKey);
            if (stored) existing = JSON.parse(stored);
          } catch {}
          // Also pull cookies from the login vault key if we don't have them
          if (!existing.cookies || (existing.cookies as unknown[]).length === 0) {
            try {
              const loginKey = `auth:${getRegistrableDomain(domain)}`;
              const loginStored = await getCredential(loginKey);
              if (loginStored) {
                const loginData = JSON.parse(loginStored);
                if (loginData.cookies?.length) existing.cookies = loginData.cookies;
              }
            } catch {}
          }
          await storeCredential(rawKey, JSON.stringify({
            ...existing,
            headers: { ...(existing.headers ?? {}), ...authHeaders },
          }));
          log("capture", `early auth store: ${Object.keys(authHeaders).join(", ")} for ${domain}`);
        }
      } catch (e) { log("capture", `early auth store failed: ${e instanceof Error ? e.message : String(e)}`); }
    }

    // Stop HAR recording — skip entirely when CDP captured data.
    // Kuri harStop hangs indefinitely on heavy sites (LinkedIn 256+ buffered events)
    // because the Zig sendJson write fails on large buffers and the promise never settles.
    let harEntries: kuri.KuriHarEntry[] = [];
    if (cdpRequestMap.size === 0) {
      // No CDP data — need Kuri HAR as primary source
      try {
        const harResult = await Promise.race([
          kuri.harStop(tabId),
          new Promise<{ entries: kuri.KuriHarEntry[] }>((r) => setTimeout(() => r({ entries: [] }), 5000)),
        ]);
        harEntries = harResult.entries ?? [];
      } catch { /* harStop failed */ }
    } else {
      // CDP has the data — fire harStop in background, don't await
      kuri.harStop(tabId).catch(() => {});
    }

    // Close CDP websocket and merge CDP-captured entries into HAR
    // Wait briefly for pending getResponseBody callbacks
    if (cdpPendingBodies.size > 0) {
      await new Promise(r => setTimeout(r, 1500));
    }
    if (cdpWs) {
      try { cdpWs.close(); } catch {}
    }
    // Build final CDP HAR entries with response bodies
    const harUrls = new Set(harEntries.map(e => e.request?.url).filter(Boolean));
    let cdpAdded = 0;
    for (const [requestId, req] of cdpRequestMap) {
      if (harUrls.has(req.url)) continue;
      const resp = cdpResponseMeta.get(requestId);
      if (!resp) continue;
      const body = cdpResolvedBodies.get(req.url);
      harEntries.push({
        startedDateTime: new Date().toISOString(),
        request: { method: req.method, url: req.url, headers: req.headers, postData: req.postData ? { text: req.postData } : undefined },
        response: { status: resp.status, headers: resp.headers, content: body ? { text: body, mimeType: resp.mimeType } : {} },
      } as kuri.KuriHarEntry);
      // Also populate responseBodies for API URLs with resolved bodies
      if (body && body.length > 0 && !responseBodies.has(req.url)) {
        responseBodies.set(req.url, body);
      }
      cdpAdded++;
    }
    if (cdpAdded > 0) {
      log("capture", `CDP direct capture added ${cdpAdded} entries (${cdpResolvedBodies.size} with bodies, ${harEntries.length} total HAR)`);
    }

    // --- HAR-based replay ---
    // CDP HAR sees ALL network requests (even ones the JS interceptor missed).
    // For any API-like HAR entry without a body in responseBodies, replay-fetch it.
    const HAR_REPLAY_CT = /application\/json|text\/plain|\+json/i;
    let harReplayCount = 0;
    for (const entry of harEntries) {
      const harUrl = entry.request?.url;
      if (!harUrl || responseBodies.has(harUrl)) continue;
      if (REPLAY_SKIP.test(harUrl)) continue;
      const method = entry.request?.method?.toUpperCase();
      if (method === "OPTIONS" || method === "HEAD") continue;
      const status = entry.response?.status ?? 0;
      if (status < 200 || status >= 400) continue;
      const ct = (entry.response?.headers ?? []).find((h: { name: string }) => h.name.toLowerCase() === "content-type")?.value ?? "";
      if (!HAR_REPLAY_CT.test(ct) && !harUrl.includes("/api/") && !harUrl.includes("_search") && !harUrl.includes("graphql") && !harUrl.includes("youtubei")) continue;
      if (harReplayCount >= 20) break;
      try {
        const postData = method !== "GET" ? entry.request?.postData?.text : undefined;
        const replayScript = method === "GET" || !postData
          ? `(function(){var x=new XMLHttpRequest();x.open('GET','${harUrl.replace(/'/g, "\\'")}',false);x.send();return x.status>=200&&x.status<400?x.responseText:''})()`
          : `(function(){var x=new XMLHttpRequest();x.open('${method}','${harUrl.replace(/'/g, "\\'")}',false);x.setRequestHeader('Content-Type','application/json');x.send(${JSON.stringify(postData)});return x.status>=200&&x.status<400?x.responseText:''})()`;
        const body = await phase("har-replay", () => kuri.evaluate(tabId, replayScript));
        if (typeof body === "string" && body.length > 0 && body.length < 512 * 1024) {
          responseBodies.set(harUrl, body);
          harReplayCount++;
          log("capture", `har-replay-fetched ${harUrl.substring(0, 80)} (${body.length}B)`);
        }
      } catch { /* non-fatal */ }
    }
    if (harReplayCount > 0) {
      log("capture", `har-replay-fetched ${harReplayCount} API response bodies from HAR entries`);
    }

    const har_lineage_id = nanoid();

    // Debug: log captured counts
    log("capture", `tracked ${harEntries.length} HAR, ${intercepted.length} intercepted, ${extensionEntries.length} extension, ${responseBodies.size} bodies`);
    for (const [bodyUrl] of responseBodies) {
      log("capture", `response body captured: ${bodyUrl.substring(0, 150)}`);
    }

    let final_url = url;
    let html: string | undefined;
    try {
      const rawUrl = await phase("getCurrentUrl", () => kuri.getCurrentUrl(tabId));
      final_url = typeof rawUrl === "string" ? rawUrl : String(rawUrl ?? url);
      // Validate it's actually a URL, fall back to original if not
      try { new URL(final_url); } catch { final_url = url; }
      html = await phase("getPageHtml", () => kuri.getPageHtml(tabId));
    } catch {}

    // --- Embedded SSR data extraction ---
    // Many SPAs (YouTube Music, Next.js, Nuxt) embed API data in the initial HTML
    // via global JS variables. Extract these as synthetic API responses.
    const SSR_DATA_EXTRACTORS = [
      // YouTube Music: ytcfg.get('YTMUSIC_INITIAL_DATA') + API key/context for execute
      { name: "ytmusic", script: `(function(){try{var d=ytcfg.get('YTMUSIC_INITIAL_DATA');if(!d||!d.length)return null;var out={};d.forEach(function(x){if(x.path&&x.data)out[x.path]=x.data});out.__apiKey=ytcfg.get('INNERTUBE_API_KEY')||'';out.__context=ytcfg.get('INNERTUBE_CONTEXT')||null;return JSON.stringify(out)}catch(e){return null}})()` },
      // Regular YouTube: window.ytInitialData
      { name: "youtube", script: `(function(){try{return typeof ytInitialData!=='undefined'?JSON.stringify(ytInitialData):null}catch(e){return null}})()` },
      // Next.js: window.__NEXT_DATA__
      { name: "nextjs", script: `(function(){try{return window.__NEXT_DATA__?JSON.stringify(window.__NEXT_DATA__):null}catch(e){return null}})()` },
      // Nuxt: window.__NUXT__
      { name: "nuxt", script: `(function(){try{return window.__NUXT__?JSON.stringify(window.__NUXT__):null}catch(e){return null}})()` },
    ];
    let embeddedDataCount = 0;
    for (const extractor of SSR_DATA_EXTRACTORS) {
      try {
        const raw = await phase(`ssr:${extractor.name}`, () => kuri.evaluate(tabId, extractor.script));
        if (typeof raw !== "string" || !raw || raw === "null") continue;
        // For ytmusic, we get {"/search": {...}, "/guide": {...}}
        // Create a synthetic response for each path
        if (extractor.name === "ytmusic") {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const apiKey = (parsed.__apiKey as string) || "";
          const innertubeContext = parsed.__context as Record<string, unknown> | null;
          delete parsed.__apiKey;
          delete parsed.__context;
          for (const [path, data] of Object.entries(parsed)) {
            if (!data || typeof data !== "object") continue;
            // Strip framework noise (responseContext, trackingParams) and keep content
            const cleaned = { ...(data as Record<string, unknown>) };
            delete cleaned.responseContext;
            delete cleaned.trackingParams;
            delete cleaned.header;
            delete cleaned.background;
            // For large bodies, compact to ~10KB to avoid schema noise in scoring
            let bodyStr = JSON.stringify(cleaned);
            if (bodyStr.length > 10_000) {
              bodyStr = bodyStr.substring(0, 10_000) + '"}]}';
              try { JSON.parse(bodyStr); } catch { bodyStr = JSON.stringify(cleaned).substring(0, 10_000); }
            }
            if (bodyStr.length < 100) continue;
            const origin = new URL(url).origin;
            const contextParams = new URL(url).searchParams;
            // Build URL with API key for direct execution
            const keyParam = apiKey ? `key=${apiKey}&` : "";
            const queryStr = path.includes("search") && contextParams.toString()
              ? `?${keyParam}${contextParams.toString()}&prettyPrint=false`
              : `?${keyParam}prettyPrint=false`;
            const syntheticUrl = `${origin}/youtubei/v1${path}${queryStr}`;
            responseBodies.set(syntheticUrl, bodyStr);
            // Construct POST body with embedded context — context is fixed per session,
            // only query varies. Embed full context so execute doesn't require it as a param.
            const queryValue = contextParams.get("q") ?? "";
            const postBody = path.includes("search") && innertubeContext
              ? JSON.stringify({ context: innertubeContext, query: queryValue })
              : path.includes("browse") && innertubeContext
                ? JSON.stringify({ context: innertubeContext, browseId: "FEmusic_liked_videos" })
                : JSON.stringify({ context: innertubeContext ?? {} });
            harEntries.push({
              startedDateTime: new Date().toISOString(),
              request: { method: "POST", url: syntheticUrl, headers: [{ name: "content-type", value: "application/json" }], postData: { text: postBody } },
              response: { status: 200, headers: [{ name: "content-type", value: "application/json" }], content: { text: bodyStr, mimeType: "application/json" } },
            } as any);
            embeddedDataCount++;
            log("capture", `ssr:${extractor.name} extracted ${path} (${bodyStr.length}B)`);
          }
        } else {
          // Generic: single object
          if (raw.length < 100) continue;
          const syntheticUrl = `${new URL(url).origin}/__ssr_data__/${extractor.name}`;
          responseBodies.set(syntheticUrl, raw);
          harEntries.push({
            startedDateTime: new Date().toISOString(),
            request: { method: "GET", url: syntheticUrl, headers: [] },
            response: { status: 200, headers: [{ name: "content-type", value: "application/json" }], content: { text: raw, mimeType: "application/json" } },
          } as any);
          embeddedDataCount++;
          log("capture", `ssr:${extractor.name} extracted (${raw.length}B)`);
        }
      } catch { /* extractor failed — non-fatal */ }
    }
    if (embeddedDataCount > 0) {
      log("capture", `embedded SSR data: ${embeddedDataCount} synthetic endpoints injected`);
    }

    // --- HTML preload/prefetch link extraction ---
    // Many SPAs (NUSMods, Next.js, SvelteKit) declare the data API as
    //   <link rel="preload"  as="fetch" href="https://api.example.com/data.json">
    //   <link rel="prefetch" href="https://api.example.com/data.json">
    // The browser fetches these eagerly, but if Kuri's close races the preload
    // we lose them. Read the head directly and fetch any API-shaped href via
    // an in-page XHR so cookies + headers replay correctly.
    try {
      const preloadRaw = await phase("preload-links", () => kuri.evaluate(tabId, `(function(){
        try {
          var out = [];
          var links = document.querySelectorAll('link[rel="preload"][as="fetch"][href], link[rel="prefetch"][href]');
          for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href');
            if (!href) continue;
            try { href = new URL(href, document.baseURI).href; } catch (e) { continue; }
            if (!/^https?:/.test(href)) continue;
            out.push(href);
          }
          return JSON.stringify(out);
        } catch (e) { return '[]'; }
      })()`));
      if (typeof preloadRaw === "string" && preloadRaw.startsWith("[")) {
        const hrefs: string[] = JSON.parse(preloadRaw);
        const apiShaped = hrefs.filter((h) => {
          if (responseBodies.has(h)) return false;
          return /\.json($|\?)|\/(api|v\d|graphql|rest|gql)\//i.test(h);
        }).slice(0, 10);
        let preloadFetchCount = 0;
        await Promise.allSettled(apiShaped.map(async (href) => {
          try {
            const body = await kuri.evaluate(
              tabId,
              `(function(){var x=new XMLHttpRequest();x.open('GET','${href.replace(/'/g, "\\'")}',false);x.send();return x.status>=200&&x.status<400?x.responseText:''})()`,
            );
            if (typeof body === "string" && body.length > 0 && body.length < 512 * 1024) {
              responseBodies.set(href, body);
              harEntries.push({
                startedDateTime: new Date().toISOString(),
                request: { method: "GET", url: href, headers: [] },
                response: { status: 200, headers: [{ name: "content-type", value: body.trim().startsWith("{") || body.trim().startsWith("[") ? "application/json" : "text/plain" }], content: { text: body, mimeType: "application/json" } },
              } as any);
              preloadFetchCount++;
            }
          } catch { /* non-fatal */ }
        }));
        if (preloadFetchCount > 0) {
          log("capture", `preload-link extraction: ${preloadFetchCount} of ${apiShaped.length} API-shaped preloads fetched`);
        }
      }
    } catch { /* non-fatal */ }

    // Merge all passive capture sources into unified request list
    const requests: RawRequest[] = mergePassiveCaptureData(intercepted, harEntries, extensionEntries, responseBodies, performanceUrls);
    log("capture", `tracked ${harEntries.length} HAR, ${intercepted.length} intercepted, ${extensionEntries.length} extension, ${responseBodies.size} bodies → ${requests.length} merged`);

    // Extract session cookies via document.cookie
    const rawCookies = await phase("extractCookies", () => extractCookiesFromPage(tabId, url));
    const sessionCookies = filterFirstPartySessionCookies(rawCookies, url, final_url);
    // Best-effort: extract page_metadata (anti-bot localStorage tokens + embedded SSR JSON)
    // after full page settle. Stored as page_state on CaptureResult; propagated to
    // SkillOperationNode.page_metadata via buildSkillOperationGraph for DAG recomputation.
    // Named postEvalScript to mirror the bundle-replay postEval mechanism (see src/sandbox/bundle-replay-client.ts).
    try {
      const postEvalScript = `(function() {
        var ANTIBOT = ["_px", "_cbl", "cf_", "CRAWL", "pxde", "__cf", "datadome", "incap_", "_abck"];
        var ls = {};
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && ANTIBOT.some(function(p) { return k.indexOf(p) === 0; })) {
            ls[k] = localStorage.getItem(k) || "";
          }
        }
        var embedded = [];
        var scripts = document.querySelectorAll("script[type=application/json]");
        for (var j = 0; j < scripts.length && j < 5; j++) {
          try { var p = JSON.parse(scripts[j].textContent || ""); if (p && typeof p === "object") embedded.push(p); } catch {}
        }
        return JSON.stringify({ ls: ls, embedded: embedded });
      })()`;
      const psRaw = await kuri.evaluate(tabId, postEvalScript);
      if (typeof psRaw === "string") {
        const ps = JSON.parse(psRaw) as { ls: Record<string, string>; embedded: Record<string, unknown>[] };
        const hasLs = Object.keys(ps.ls ?? {}).length > 0;
        const hasEmb = (ps.embedded ?? []).length > 0;
        if (hasLs || hasEmb) pageState = { localStorage: ps.ls, embedded_json: ps.embedded };
      }
    } catch { /* page_state extraction is best-effort — never block capture */ }

    if (captureTimedOut) {
      if (noProgressBail) {
        // Plan-v12 Phase B: distinct error code so executeBrowserCapture
        // can route to SSR fast-path rescue instead of returning generic
        // capture_timeout. cdpRequestMap was empty at fire time → page
        // never started network activity → libcurl-impersonate is the
        // best chance at meaningful HTML.
        throw Object.assign(
          new Error(`captureSession no_progress_bail after ${CAPTURE_NO_PROGRESS_MS}ms for ${url}`),
          { code: "no_progress_bail" },
        );
      }
      throw new Error(`captureSession timed out after ${CAPTURE_TIMEOUT_MS}ms for ${url}`);
    }
    log("capture", `captured ${jsBundleBodies.size} JS bundles for route scanning`);

    const responseBodyCount = responseBodies.size;
    const capturedRequestUrls = requests.map((request) => request.url);
    const hasUsefulResponseBodies = hasUsefulCapturedResponses(responseBodies.keys(), url, intent);
    const hasUsefulCapturedRequests = hasUsefulCapturedResponses(capturedRequestUrls, url, intent);
    const hasRichCapturedTraffic = requests.length >= 25;
    if (
      isBlockedAppShell(html) &&
      responseBodyCount < 10 &&
      !hasUsefulResponseBodies &&
      !hasUsefulCapturedRequests &&
      !hasRichCapturedTraffic
    ) {
      // On ephemeral retry, surface a structured auth/block instead of throwing a
      // generic "failed without returning" error after the second pass.
      if (options?.forceEphemeral) {
        const cloudflareBlocked = !!html && /Cloudflare|cf\.errors\.css|cf-error-details/i.test(html);
        throw Object.assign(new Error(cloudflareBlocked ? "cloudflare_waf_block" : "blocked_app_shell"), {
          code: "auth_required",
          login_url: final_url || url,
          ...(cloudflareBlocked ? { reason: "cloudflare_waf" } : { reason: "blocked_app_shell" }),
        });
      }
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
        // Harness #2: Visual context
        screenshots: Object.keys(screenshots).length > 0 ? screenshots : undefined,
        page_state: pageState,
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
    if (noProgressHandle) clearTimeout(noProgressHandle);
    abortController.abort(); // no-op if already aborted; prevents stale phase rejections
    await resetTab(tabId);
    releaseTabSlot(tabId);
  }
  if (retryFreshTab && !options?.forceEphemeral) {
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
  if (!isBrowserAccessAvailable()) {
    throw new Error("Browser access is not available (proxy-only config)");
  }
  await kuri.start();
  await kuri.discoverTabs();

  let tabId: string;
  try {
    tabId = await openFreshCaptureTab();
  } catch (error) {
    releaseTabSlot("no-tab");
    throw error;
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
    tabId = await openFreshCaptureTab();
  } catch (error) {
    releaseTabSlot("no-tab");
    throw error;
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

// ---------------------------------------------------------------------------
// First-pass browser action execution (Lane 1: browser action floor)
//
// When no reusable second-pass route exists, the browser completes the task
// directly using action primitives. Passive reverse-engineering (HAR capture,
// interceptor, bundle scanning) runs in the background simultaneously.
// ---------------------------------------------------------------------------

/** A single step in a browser action sequence. */
export interface BrowserActionStep {
  /** Action to perform. "snapshot" takes an a11y snapshot to discover refs. */
  action: kuri.KuriActionType | "snapshot" | "navigate" | "wait" | "type" | "evaluate";
  /** Element ref from the a11y snapshot (e.g. "e5"). Required for click/fill/select/etc. */
  ref?: string;
  /** Value for fill/select/type/press/evaluate, URL for navigate, selector for wait. */
  value?: string;
  /** Timeout in ms for wait actions. */
  timeoutMs?: number;
}

/** Internal record of when each action step started, used for request provenance tagging. */
interface StepTimingEntry {
  stepIndex: number;
  action: string;
  ref?: string;
  startedAt: string; // ISO timestamp
}

/**
 * Tag captured requests with the action step that triggered them.
 * Uses timestamp comparison: a request is attributed to the latest step
 * whose startedAt is <= the request's timestamp. Requests that arrived
 * before any step (e.g. during initial navigation) are left untagged.
 *
 * Exported for testability.
 */
export function tagRequestProvenance(
  requests: RawRequest[],
  stepTimings: StepTimingEntry[],
): void {
  if (stepTimings.length === 0) return;

  // Sort step timings by startedAt ascending (should already be, but be safe)
  const sorted = [...stepTimings].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );

  for (const req of requests) {
    if (!req.timestamp) continue;
    const reqTime = new Date(req.timestamp).getTime();

    // Find the latest step that started at or before this request's timestamp
    let matchedStep: StepTimingEntry | undefined;
    for (const step of sorted) {
      if (new Date(step.startedAt).getTime() <= reqTime) {
        matchedStep = step;
      } else {
        break;
      }
    }

    if (matchedStep) {
      req.triggered_by_step = matchedStep.stepIndex;
      req.triggered_by_action = matchedStep.action;
      req.triggered_by_ref = matchedStep.ref;
    }
  }
}

/** Result of a first-pass browser action execution. */
export interface BrowserActionResult {
  /** Whether the action sequence completed without errors. */
  ok: boolean;
  /** Per-step results. */
  steps: Array<{ action: string; ok: boolean; result?: unknown; error?: string }>;
  /** Final page URL after all actions. */
  final_url: string;
  /** Final page HTML (for downstream extraction). */
  html?: string;
  /** Last a11y snapshot (compact text-tree). */
  snapshot?: string;
  /** Passive capture result gathered during action execution. */
  capture?: CaptureResult;
  trace_id: string;
}

/**
 * Execute a sequence of browser actions on a page while running passive
 * capture in the background. This is the "first pass" — the browser does
 * the task now, and the captured network traffic feeds reverse-engineering
 * for a cheaper second pass next time.
 */
export async function executeActionSequence(
  url: string,
  steps: BrowserActionStep[],
  options?: {
    authHeaders?: Record<string, string>;
    cookies?: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number }>;
    intent?: string;
    /** Skip passive capture (useful for quick action-only flows). */
    skipCapture?: boolean;
  },
): Promise<BrowserActionResult> {
  await acquireTabSlot();
  await kuri.start();
  await kuri.discoverTabs();

  let tabId: string;
  try {
    tabId = await openFreshCaptureTab();
  } catch (error) {
    releaseTabSlot("no-tab");
    throw error;
  }
  activeTabRegistry.add(tabId);

  const traceId = nanoid();
  const stepResults: BrowserActionResult["steps"] = [];
  const stepTimings: StepTimingEntry[] = [];
  try {
    // Setup: headers + cookies
    const allHeaders = { ...CLIENT_HINT_HEADERS, ...(options?.authHeaders ?? {}) };
    await kuri.setHeaders(tabId, allHeaders);
    if (options?.cookies?.length) {
      await injectCookies(tabId, options.cookies);
    }

    // Start background passive capture (HAR + interceptor)
    if (!options?.skipCapture) {
      await kuri.harStart(tabId);
      await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {});
    }

    // Navigate to the starting URL
    await kuri.navigate(tabId, url);
    await kuri.waitForLoad(tabId, CAPTURE_NAV_TIMEOUT_MS);

    // Re-inject interceptor after navigation
    if (!options?.skipCapture) {
      await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {});
    }

    // Execute each action step
    for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
      const step = steps[stepIdx];
      // Record step start time for request provenance tagging (#214)
      stepTimings.push({
        stepIndex: stepIdx,
        action: step.action,
        ref: step.ref,
        startedAt: new Date().toISOString(),
      });
      try {
        let result: unknown;
        switch (step.action) {
          case "snapshot":
            result = await kuri.snapshot(tabId, step.value);
            break;

          case "navigate":
            if (!step.value) throw new Error("navigate requires a value (URL)");
            await kuri.navigate(tabId, step.value);
            await kuri.waitForLoad(tabId, step.timeoutMs ?? CAPTURE_NAV_TIMEOUT_MS);
            // Re-inject interceptor after navigation
            if (!options?.skipCapture) {
              await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {});
            }
            result = await kuri.getCurrentUrl(tabId);
            break;

          case "wait":
            result = await kuri.waitForSelector(tabId, step.value, step.timeoutMs ?? 5000);
            break;

          case "type":
            if (!step.value) throw new Error("type requires a value (text)");
            result = await kuri.keyboardType(tabId, step.value);
            break;

          case "evaluate":
            if (!step.value) throw new Error("evaluate requires a value (expression)");
            result = await kuri.evaluate(tabId, step.value);
            break;

          case "click":
          case "dblclick":
          case "hover":
          case "focus":
          case "blur":
          case "check":
          case "uncheck":
            if (!step.ref) throw new Error(`${step.action} requires a ref`);
            result = await kuri.action(tabId, step.action, step.ref);
            break;

          case "fill":
          case "select":
            if (!step.ref) throw new Error(`${step.action} requires a ref`);
            if (!step.value) throw new Error(`${step.action} requires a value`);
            result = await kuri.action(tabId, step.action, step.ref, step.value);
            break;

          case "scroll":
            result = await kuri.scroll(tabId);
            break;

          case "press":
            if (!step.value) throw new Error("press requires a value (key)");
            result = await kuri.press(tabId, step.value);
            break;
        }

        stepResults.push({ action: step.action, ok: true, result });
      } catch (err) {
        stepResults.push({
          action: step.action,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Collect final state
    const rawFinalUrl = await kuri.getCurrentUrl(tabId).catch(() => url);
    const finalUrl = typeof rawFinalUrl === "string" && rawFinalUrl.startsWith("http") ? rawFinalUrl : url;
    const rawHtml = await kuri.getPageHtml(tabId).catch(() => undefined);
    const html = typeof rawHtml === "string" && rawHtml.trimStart().startsWith("<") ? rawHtml : undefined;
    const lastSnapshot = await kuri.snapshot(tabId).catch(() => undefined);

    // Collect passive capture in the background
    let capture: CaptureResult | undefined;
    if (!options?.skipCapture) {
      try {
        const domain = new URL(url).hostname;
        const harResult = await kuri.harStop(tabId);
        const intercepted = await collectInterceptedRequests(tabId);
        const responseBodies = new Map<string, string>();
        for (const entry of intercepted) {
          if (entry.response_body && !entry.is_js) {
            responseBodies.set(entry.url, entry.response_body);
          }
        }

        const requests: RawRequest[] = harResult.entries.map((entry) => {
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

        // Add intercepted requests not in HAR
        const harUrls = new Set(harResult.entries.map((e) => e.request.url));
        for (const entry of intercepted) {
          if (entry.is_js || harUrls.has(entry.url)) continue;
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

        // Tag each request with the action step that triggered it (#214)
        tagRequestProvenance(requests, stepTimings);

        const sessionCookies = filterFirstPartySessionCookies(
          await extractCookiesFromPage(tabId, url),
          url,
          finalUrl,
        );

        capture = {
          requests,
          har_lineage_id: nanoid(),
          domain,
          cookies: sessionCookies.length > 0 ? sessionCookies : undefined,
          final_url: finalUrl,
          ws_messages: undefined,
          html,
        };
      } catch (err) {
        log("capture", `background capture collection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      ok: stepResults.every((s) => s.ok),
      steps: stepResults,
      final_url: finalUrl,
      html,
      snapshot: lastSnapshot,
      capture,
      trace_id: traceId,
    };
  } finally {
    await resetTab(tabId);
    releaseTabSlot(tabId);
  }
}
