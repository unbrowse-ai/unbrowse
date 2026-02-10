/**
 * Header Profiler — Capture, classify, and resolve browser headers for replay.
 *
 * Builds a header "template" from HAR traffic using frequency analysis.
 * At replay time, resolves template + auth headers into a full header set
 * that mimics what the browser originally sent.
 *
 * For index users, primeHeaders() opens the target site in a browser briefly
 * to hydrate the template with fresh values.
 */

import type {
  HarEntry,
  HeaderCategory,
  HeaderProfileFile,
  DomainHeaderProfile,
  CapturedHeader,
  EndpointHeaderOverride,
} from "./types.js";
import { HeaderClassifier } from "./auth-extractor.js";

/** Default browser control API port. */
const DEFAULT_BROWSER_PORT = 18791;

// ── Header Classification ──────────────────────────────────────────────────

/** Protocol-level headers that should never be replayed. */
const PROTOCOL_HEADERS = new Set([
  ":authority", ":method", ":path", ":scheme", ":status", ":protocol",
  "host", "connection", "keep-alive", "content-length", "transfer-encoding",
  "upgrade", "proxy-connection", "proxy-authorization",
]);

/** Browser-auto-added headers — can't/shouldn't be set from Node.js. */
const BROWSER_HEADERS = new Set([
  "accept-encoding",
]);

/** Browser-auto-added prefixes. */
const BROWSER_PREFIXES = ["sec-fetch-", "sec-ch-"];

/** Known context headers (browser settings/navigation context). */
const CONTEXT_HEADERS = new Set([
  "accept", "accept-language", "user-agent", "referer", "origin",
  "dnt", "cache-control", "pragma",
]);

const classifier = new HeaderClassifier();

/**
 * Classify a header into a category for capture/replay decisions.
 *
 * Priority order: protocol > browser > cookie > auth > context > app (catch-all)
 */
export function classifyHeader(name: string): HeaderCategory {
  const lower = name.toLowerCase();

  // Protocol headers (HTTP/2 pseudo, transport)
  if (lower.startsWith(":") || PROTOCOL_HEADERS.has(lower)) return "protocol";

  // Browser-auto-added headers
  if (BROWSER_HEADERS.has(lower)) return "browser";
  if (BROWSER_PREFIXES.some(p => lower.startsWith(p))) return "browser";

  // Cookie header (handled separately via cookie jar)
  if (lower === "cookie" || lower === "set-cookie") return "cookie";

  // Auth headers (existing auth-extractor classification)
  if (classifier.isAuthLike(lower)) return "auth";

  // Known context headers (browser settings / navigation)
  if (CONTEXT_HEADERS.has(lower)) return "context";

  // Everything else is an app header — site-specific, must be captured
  return "app";
}

// ── Profile Building ───────────────────────────────────────────────────────

/** Minimum threshold for a header to be considered "common" on a domain. */
const COMMON_THRESHOLD = 0.8;

/**
 * Build header profiles from HAR entries using frequency analysis.
 *
 * For each target domain, counts how often each header appears across requests.
 * Headers appearing on >= 80% of requests become "common" (sent on every replay).
 * Headers appearing on specific endpoints but not globally become "overrides".
 *
 * Auth, browser, protocol, and cookie headers are excluded — those have their
 * own dedicated flows (auth.json, browser engine, transport layer).
 */
export function buildHeaderProfiles(
  entries: HarEntry[],
  targetDomains: Set<string>,
): HeaderProfileFile {
  // Collect per-domain header stats
  const domainStats = new Map<string, {
    headerCounts: Map<string, { name: string; values: string[]; count: number }>;
    requestCount: number;
  }>();

  // Also collect per-endpoint headers for override detection
  const endpointHeaders = new Map<string, {
    headers: Map<string, { name: string; value: string }>;
    count: number;
  }>();

  for (const entry of entries) {
    let domain: string;
    try {
      domain = new URL(entry.request.url).hostname;
    } catch {
      continue;
    }

    if (!targetDomains.has(domain)) continue;

    // Init domain stats
    if (!domainStats.has(domain)) {
      domainStats.set(domain, { headerCounts: new Map(), requestCount: 0 });
    }
    const stats = domainStats.get(domain)!;
    stats.requestCount++;

    // Build endpoint key for override detection (includes domain to avoid
    // cross-domain confusion when multiple target domains are captured)
    const urlObj = new URL(entry.request.url);
    const endpointKey = `${domain}|${entry.request.method} ${urlObj.pathname}`;

    if (!endpointHeaders.has(endpointKey)) {
      endpointHeaders.set(endpointKey, { headers: new Map(), count: 0 });
    }
    const epStats = endpointHeaders.get(endpointKey)!;
    epStats.count++;

    // Count each header
    for (const { name, value } of entry.request.headers) {
      const category = classifyHeader(name);

      // Skip categories handled elsewhere
      if (category === "auth" || category === "browser" || category === "protocol" || category === "cookie") {
        continue;
      }

      const lower = name.toLowerCase();
      const existing = stats.headerCounts.get(lower);
      if (existing) {
        existing.count++;
        existing.values.push(value);
      } else {
        stats.headerCounts.set(lower, { name, values: [value], count: 1 });
      }

      // Track per-endpoint
      epStats.headers.set(lower, { name, value });
    }
  }

  // Build profiles
  const domains: Record<string, DomainHeaderProfile> = {};
  const endpointOverrides: Record<string, EndpointHeaderOverride> = {};

  for (const [domain, stats] of domainStats) {
    const commonHeaders: Record<string, CapturedHeader> = {};
    const threshold = stats.requestCount * COMMON_THRESHOLD;

    for (const [lower, headerStats] of stats.headerCounts) {
      if (headerStats.count >= threshold) {
        // Pick most frequent value
        const valueCounts = new Map<string, number>();
        for (const v of headerStats.values) {
          valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
        }
        let bestValue = headerStats.values[0];
        let bestCount = 0;
        for (const [v, c] of valueCounts) {
          if (c > bestCount) { bestValue = v; bestCount = c; }
        }

        commonHeaders[lower] = {
          name: headerStats.name,
          value: bestValue,
          category: classifyHeader(headerStats.name),
          seenCount: headerStats.count,
        };
      }
    }

    domains[domain] = {
      domain,
      commonHeaders,
      requestCount: stats.requestCount,
      capturedAt: new Date().toISOString(),
    };
  }

  // Detect per-endpoint overrides (headers that appear on specific endpoints
  // but NOT in the domain's common set)
  for (const [compositeKey, epStats] of endpointHeaders) {
    if (epStats.count < 2) continue; // Need at least 2 samples

    // Parse domain from composite key "domain|METHOD /path"
    const pipeIdx = compositeKey.indexOf("|");
    const domain = compositeKey.substring(0, pipeIdx);
    const endpointKey = compositeKey.substring(pipeIdx + 1);
    const overrideHeaders: Record<string, string> = {};

    const domainProfile = domains[domain];
    if (!domainProfile) continue;

    for (const [lower, { name, value }] of epStats.headers) {
      // If not in common headers OR value differs significantly
      const common = domainProfile.commonHeaders[lower];
      if (!common) {
        // Header is endpoint-specific
        const category = classifyHeader(name);
        if (category !== "auth" && category !== "browser" && category !== "protocol" && category !== "cookie") {
          overrideHeaders[lower] = value;
        }
      } else if (common.value !== value) {
        // Value differs from common — this endpoint needs a specific value
        overrideHeaders[lower] = value;
      }
    }

    if (Object.keys(overrideHeaders).length > 0) {
      endpointOverrides[endpointKey] = {
        endpointPattern: endpointKey,
        headers: overrideHeaders,
      };
    }
  }

  return {
    version: 1,
    domains,
    endpointOverrides,
  };
}

// ── Header Resolution ──────────────────────────────────────────────────────

/**
 * Resolve the full header set for a request by merging:
 * 1. Domain common headers from template (context + app categories)
 * 2. Endpoint-specific overrides
 * 3. Auth headers (always win for auth keys)
 * 4. Cookies as Cookie header
 *
 * Later layers override earlier ones (auth > overrides > common).
 *
 * @param mode — Defaults to "node" (recommended for Node.js fetch).
 *   "node" excludes context headers (user-agent, accept, referer, origin, etc.)
 *   because sending browser-like context headers from Node.js triggers TLS
 *   fingerprint mismatch detection (Cloudflare sees User-Agent=Chrome but
 *   TLS=Node.js → blocks the request). Only app-specific custom headers
 *   (x-requested-with, x-app-version, etc.) are included.
 *   "browser" includes all captured headers (context + app) — use only when
 *   executing in a real browser (execInChrome) where TLS matches the UA.
 */
export function resolveHeaders(
  profile: HeaderProfileFile | undefined,
  domain: string,
  method: string,
  path: string,
  authHeaders: Record<string, string>,
  cookies: Record<string, string>,
  mode: "browser" | "node" = "node",
): Record<string, string> {
  const result: Record<string, string> = {};

  if (profile) {
    // Layer 1: Domain common headers
    const domainProfile = profile.domains[domain];
    if (domainProfile) {
      for (const [, header] of Object.entries(domainProfile.commonHeaders)) {
        // In node mode, skip context headers (user-agent, accept, referer, etc.)
        // to avoid TLS fingerprint mismatch detection
        if (mode === "node" && header.category === "context") continue;
        result[header.name] = header.value;
      }
    }

    // Layer 2: Endpoint overrides
    const endpointKey = `${method} ${path}`;
    const override = profile.endpointOverrides[endpointKey];
    if (override) {
      for (const [key, value] of Object.entries(override.headers)) {
        // In node mode, check if the override is for a context header
        if (mode === "node") {
          const category = classifyHeader(key);
          if (category === "context") continue;
        }
        // Use original case from common headers if available, else the key as-is
        const original = domainProfile?.commonHeaders[key];
        result[original?.name ?? key] = value;
      }
    }
  }

  // Layer 3: Auth headers (always win)
  for (const [name, value] of Object.entries(authHeaders)) {
    result[name] = value;
  }

  // Layer 4: Cookies
  if (Object.keys(cookies).length > 0) {
    result["Cookie"] = Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  return result;
}

// ── Browser Header Priming ────────────────────────────────────────────────

/** Result from priming: fresh headers + cookies from a real browser session. */
export interface PrimeResult {
  headers: Record<string, string>;
  cookies: Record<string, string>;
}

/**
 * Prime header template and cookies from a real browser session.
 *
 * For index users who downloaded a skill and have no original HAR:
 * 1. Opens the target URL in the browser briefly
 * 2. Captures network requests (with real browser-generated headers)
 * 3. Captures cookies from the browser session
 * 4. Matches captured header keys against the template
 * 5. Returns hydrated headers + fresh cookies
 *
 * Falls back to template sample values for any header the browser didn't send.
 */
/** Capturer signature for dependency injection (testing). */
export type BrowserCapturer = (
  url: string,
  port: number,
) => Promise<{ headers: Map<string, string>; cookies: Record<string, string> }>;

export async function primeHeaders(
  targetUrl: string,
  profile: HeaderProfileFile,
  browserPort = DEFAULT_BROWSER_PORT,
  _capturer?: BrowserCapturer,
): Promise<PrimeResult> {
  // Collect all template header keys (lowercased) → original name + sample value
  const templateKeys = new Map<string, { name: string; value: string }>();
  for (const domainProfile of Object.values(profile.domains)) {
    for (const [lower, header] of Object.entries(domainProfile.commonHeaders)) {
      templateKeys.set(lower, { name: header.name, value: header.value });
    }
  }

  if (templateKeys.size === 0) return { headers: {}, cookies: {} };

  // Try to open browser and capture fresh headers + cookies
  const captured = await (_capturer ?? captureFromBrowser)(targetUrl, browserPort);

  // Build headers: match template keys against captured headers
  const headers: Record<string, string> = {};
  for (const [lower, { name, value: sampleValue }] of templateKeys) {
    const freshValue = captured.headers.get(lower);
    headers[name] = freshValue ?? sampleValue;
  }

  return { headers, cookies: captured.cookies };
}

/**
 * Connect to a running Chrome via CDP, open the target URL, capture headers + cookies.
 *
 * Tries CDP on the given port first, then common debug ports (9222, 9229).
 * If no running Chrome is found, launches a headless Chromium via Playwright.
 */
async function captureFromBrowser(
  targetUrl: string,
  port: number,
): Promise<{ headers: Map<string, string>; cookies: Record<string, string> }> {
  const headers = new Map<string, string>();
  const cookies: Record<string, string> = {};
  const empty = { headers, cookies };

  let targetDomain: string;
  try {
    targetDomain = new URL(targetUrl).hostname;
  } catch {
    return empty;
  }

  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    // Playwright not installed — can't capture
    return empty;
  }

  // Try connecting to an existing Chrome via CDP
  let browser: import("playwright").Browser | null = null;
  let ownsBrowser = false;
  // Prefer OpenClaw-managed Chrome (CDP :18800) when available.
  for (const p of [port, 18800, 9222, 9229, 18792]) {
    try {
      browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${p}`, { timeout: 3000 });
      break;
    } catch { /* port not available */ }
  }

  // Fallback: launch headless Chromium
  if (!browser) {
    try {
      browser = await pw.chromium.launch({ headless: true });
      ownsBrowser = true;
    } catch {
      return empty;
    }
  }

  let page: import("playwright").Page | null = null;
  let createdContext: import("playwright").BrowserContext | null = null;
  try {
    const existingContext = ownsBrowser ? null : browser.contexts()[0];
    const context = existingContext ?? await browser.newContext();
    if (!existingContext) createdContext = context;
    page = await context.newPage();

    // Intercept requests to capture headers
    page.on("request", (req) => {
      try {
        const reqDomain = new URL(req.url()).hostname;
        if (reqDomain !== targetDomain) return;
        for (const [name, value] of Object.entries(req.headers())) {
          const category = classifyHeader(name);
          if (category !== "protocol" && category !== "browser") {
            headers.set(name.toLowerCase(), value);
          }
        }
      } catch { /* ignore */ }
    });

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(3000);

    // Capture cookies for the target domain
    const allCookies = await context.cookies(targetUrl);
    for (const c of allCookies) {
      if (c.name && c.value) {
        cookies[c.name] = c.value;
      }
    }
  } finally {
    await page?.close().catch(() => {});
    await createdContext?.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
  }

  return { headers, cookies };
}
