/**
 * HAR Parser — Extract API endpoints and metadata from HAR files.
 *
 * Ported from meta_learner_simple.py parse_har() + group_by_domain_and_path().
 */

import type { HarEntry, ParsedRequest, ApiData } from "./types.js";
import { guessAuthMethod } from "./auth-extractor.js";

/** Static asset extensions to skip. */
const STATIC_EXTS = [".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".woff", ".woff2", ".ico", ".map"];

/** Third-party domains to skip (analytics, payments, social, etc.). */
const SKIP_DOMAINS = [
  // Analytics & tracking
  "google-analytics.com", "analytics.google.com", "www.google-analytics.com",
  "mixpanel.com", "api-js.mixpanel.com", "mparticle.com", "jssdks.mparticle.com",
  "segment.io", "segment.com", "cdn.segment.com", "api.segment.io",
  "amplitude.com", "api.amplitude.com", "heap.io", "heapanalytics.com",
  "posthog.com", "i.posthog.com", "eu.i.posthog.com", "us.i.posthog.com",
  "plausible.io", "matomo.org",
  // Ads & attribution
  "doubleclick.net", "googletagmanager.com", "googlesyndication.com",
  "facebook.com", "instagram.com", "connect.facebook.net",
  "appsflyer.com", "wa.appsflyer.com", "intentiq.com", "api.intentiq.com",
  "id5-sync.com", "diagnostics.id5-sync.com", "33across.com",
  "btloader.com", "api.btloader.com", "hbwrapper.com",
  // Payments
  "stripe.com", "js.stripe.com", "r.stripe.com", "m.stripe.com",
  // Support & engagement
  "intercom.io", "api-iam.intercom.io",
  // UX & monitoring
  "hotjar.com", "clarity.ms", "sentry.io",
  // CDNs
  "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com",
  // Consent
  "onetrust.com", "geolocation.onetrust.com", "cookielaw.org", "cdn.cookielaw.org",
  // Auth providers (third-party SSO, not the target app's auth)
  "accounts.google.com", "play.google.com", "stack-auth.com", "api.stack-auth.com",
  // Cloudflare
  "cdn-cgi",
  // TikTok analytics
  "analytics.tiktok.com", "analytics-sg.tiktok.com", "mon.tiktokv.com",
  "mcs.tiktokw.com", "lf16-tiktok-web.tiktokcdn-us.com",
  // Google services (analytics, tag manager, fonts, maps, etc.)
  "www.googletagmanager.com", "www.google.com", "google.com",
  "fonts.googleapis.com", "fonts.gstatic.com", "maps.googleapis.com",
  "www.gstatic.com", "apis.google.com", "ssl.gstatic.com",
  "pagead2.googlesyndication.com", "adservice.google.com",
  "analytics.tiktok.com", "analytics-sg.tiktok.com",
  // Facebook/Meta
  "graph.facebook.com", "www.facebook.com",
  // Twitter
  "platform.twitter.com", "syndication.twitter.com",
  // Other common third-party
  "newrelic.com", "nr-data.net", "bam.nr-data.net",
  "fullstory.com", "rs.fullstory.com",
  "launchdarkly.com", "app.launchdarkly.com",
  "datadoghq.com", "browser-intake-datadoghq.com",
  "bugsnag.com", "sessions.bugsnag.com",
];

/** Auth header names to capture. */
const AUTH_HEADER_NAMES = new Set([
  "authorization", "x-api-key", "api-key", "apikey",
  "x-auth-token", "access-token", "x-access-token",
  "token", "x-token", "authtype", "mudra",
]);

/** Context header names to capture (IDs, tenant info). */
const CONTEXT_HEADER_NAMES = new Set([
  "outletid", "userid", "supplierid", "companyid",
]);

/** Path prefixes to skip (infra noise on any domain). */
const SKIP_PATHS = [
  "/cdn-cgi/", "/_next/data/", "/__nextjs", "/sockjs-node/",
  "/favicon", "/manifest.json", "/robots.txt", "/sitemap",
];

/** Check if a URL is a static asset or infra noise. */
function isStaticAsset(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  if (STATIC_EXTS.some((ext) => path.endsWith(ext))) return true;
  if (SKIP_PATHS.some((prefix) => path.startsWith(prefix))) return true;
  return false;
}

/** Check if a domain should be skipped (third-party). */
function isSkippedDomain(domain: string): boolean {
  return SKIP_DOMAINS.some((skip) => domain.includes(skip));
}

/** Check if a URL looks like an API call. */
function isApiLike(url: string, method: string, domain: string): boolean {
  return (
    url.includes("/api/") ||
    url.includes("/services/") ||
    url.includes("/v1/") ||
    url.includes("/v2/") ||
    url.includes("/v3/") ||
    url.includes("/graphql") ||
    ["POST", "PUT", "DELETE", "PATCH"].includes(method) ||
    // Allow any non-static on target domains that passed third-party filter
    domain.includes("api.") ||
    domain.includes("service")
  );
}

/** Group requests by domain:path. */
function groupByDomainAndPath(requests: ParsedRequest[]): Record<string, ParsedRequest[]> {
  const grouped: Record<string, ParsedRequest[]> = {};
  for (const req of requests) {
    const key = `${req.domain}:${req.path}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(req);
  }
  return grouped;
}

/** Derive a clean service name from a domain. */
function deriveServiceName(domain: string): string {
  let name = domain
    .replace(/^(www|api|v\d+|.*serv)\./, "")
    .replace(/\.(com|org|net|co|io|ai|app|sg|dev|xyz)\.?$/g, "")
    .replace(/\./g, "-")
    .toLowerCase();
  return name || "unknown-api";
}

/** Content-type values that indicate HTML pages (not API JSON). */
function isHtmlContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml");
}

/** Get the response content-type from a HAR entry. */
function getResponseContentType(entry: HarEntry): string | undefined {
  for (const header of entry.response?.headers ?? []) {
    if (header.name.toLowerCase() === "content-type") {
      return header.value;
    }
  }
  return undefined;
}

/**
 * Parse a HAR file or HAR JSON object into structured API data.
 *
 * Filters out static assets and third-party domains, extracts auth
 * headers/cookies, groups endpoints, and determines the service name.
 *
 * @param seedUrl - The user-provided URL that initiated the capture. Used to
 *                  derive the service name and baseUrl instead of guessing from
 *                  the most-frequent request domain (which is often a third-party
 *                  analytics domain like Google or TikTok).
 */
export function parseHar(har: { log: { entries: HarEntry[] } }, seedUrl?: string): ApiData {
  const requests: ParsedRequest[] = [];
  const authHeaders: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const authInfo: Record<string, string> = {};
  const baseUrls = new Set<string>();
  const targetDomains = new Set<string>();

  // If a seed URL is provided, extract its domain upfront for prioritization
  let seedDomain: string | undefined;
  let seedBaseUrl: string | undefined;
  if (seedUrl) {
    try {
      const parsed = new URL(seedUrl);
      seedDomain = parsed.host;
      seedBaseUrl = `${parsed.protocol}//${parsed.host}`;
    } catch { /* invalid seedUrl — ignore */ }
  }

  for (const entry of har.log?.entries ?? []) {
    const url = entry.request.url;
    const method = entry.request.method;
    const responseStatus = entry.response?.status ?? 0;
    const responseContentType = getResponseContentType(entry);

    // Skip static assets
    try {
      if (isStaticAsset(url)) continue;
    } catch {
      continue; // Invalid URL
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }

    const domain = parsed.host;

    // Skip third-party
    if (isSkippedDomain(domain)) continue;

    // Skip requests that returned full HTML pages — these are page navigations,
    // not API calls. API endpoints return JSON, XML, or similar data formats.
    // Only skip GET requests with HTML responses (POST to an HTML endpoint might
    // be a form submission returning a redirect).
    if (method === "GET" && responseContentType && isHtmlContentType(responseContentType)) {
      continue;
    }

    // Only keep API-like requests (or allow all if on a known target domain)
    if (!isApiLike(url, method, domain) && targetDomains.size > 0 && !targetDomains.has(domain)) {
      continue;
    }

    targetDomains.add(domain);
    baseUrls.add(`${parsed.protocol}//${parsed.host}`);

    // Extract auth headers
    for (const header of entry.request.headers ?? []) {
      const name = header.name.toLowerCase();
      const value = header.value;

      if (AUTH_HEADER_NAMES.has(name)) {
        authHeaders[name] = value;
        authInfo[`request_header_${name}`] = value;
      }

      if (CONTEXT_HEADER_NAMES.has(name)) {
        authInfo[`request_header_${name}`] = value;
      }
    }

    // Extract request cookies
    for (const cookie of entry.request.cookies ?? []) {
      cookies[cookie.name] = cookie.value;
      authInfo[`request_cookie_${cookie.name}`] = cookie.value;
    }

    // Extract response set-cookie
    for (const header of entry.response?.headers ?? []) {
      if (header.name.toLowerCase() === "set-cookie") {
        // Each Set-Cookie header should contain a single cookie.
        // HAR files may concatenate multiple Set-Cookie headers with newlines
        // or may have one header per cookie. Don't split on commas — dates
        // like "Expires=Thu, 01 Jan 2026" contain commas.
        const cookieStr = header.value;
        const eq = cookieStr.indexOf("=");
        if (eq > 0) {
          const cookieName = cookieStr.slice(0, eq).trim();
          const rest = cookieStr.slice(eq + 1);
          const semi = rest.indexOf(";");
          const cookieValue = semi > 0 ? rest.slice(0, semi).trim() : rest.trim();
          if (cookieName && cookieValue) {
            authInfo[`response_setcookie_${cookieName}`] = cookieValue;
          }
        }
      }
    }

    requests.push({
      method,
      url,
      path: parsed.pathname,
      domain,
      status: responseStatus,
      responseContentType,
    });
  }

  // Determine service name and base URL.
  // Priority: seed URL domain > most-common target domain > first baseUrl
  let service = "unknown-api";
  let baseUrl = "https://api.example.com";

  if (seedDomain) {
    // Use the seed URL's domain — this is what the user actually asked to capture
    service = deriveServiceName(seedDomain);
    baseUrl = seedBaseUrl!;
  } else if (targetDomains.size > 0) {
    const domainCounts: Record<string, number> = {};
    for (const req of requests) {
      domainCounts[req.domain] = (domainCounts[req.domain] ?? 0) + 1;
    }
    const mainDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (mainDomain) {
      service = deriveServiceName(mainDomain);
      baseUrl = `https://${mainDomain}`;
    }
  } else if (baseUrls.size > 0) {
    const first = [...baseUrls][0];
    const domain = new URL(first).host;
    service = deriveServiceName(domain);
    baseUrl = first;
  }

  return {
    service,
    baseUrls: [...baseUrls],
    baseUrl,
    authHeaders,
    authMethod: guessAuthMethod(authHeaders, cookies),
    cookies,
    authInfo,
    requests,
    endpoints: groupByDomainAndPath(requests),
  };
}

/**
 * Merge OpenAPI spec endpoints into existing API data.
 *
 * Endpoints from the spec that weren't already discovered via traffic
 * capture are added with status 0 and fromSpec=true.
 */
export function mergeOpenApiEndpoints(
  apiData: ApiData,
  openApiEndpoints: { method: string; path: string; summary?: string }[],
  baseUrl: string,
): ApiData {
  const existingKeys = new Set<string>();
  for (const [, reqs] of Object.entries(apiData.endpoints)) {
    for (const r of reqs) {
      existingKeys.add(`${r.method}:${r.path}`);
    }
  }

  let domain: string;
  try {
    domain = new URL(baseUrl).host;
  } catch {
    domain = "unknown";
  }

  for (const ep of openApiEndpoints) {
    const key = `${ep.method}:${ep.path}`;
    if (existingKeys.has(key)) continue;

    const groupKey = `${domain}:${ep.path}`;
    const syntheticRequest: ParsedRequest = {
      method: ep.method,
      url: `${baseUrl.replace(/\/$/, "")}${ep.path}`,
      path: ep.path,
      domain,
      status: 0,
      fromSpec: true,
    };

    if (!apiData.endpoints[groupKey]) {
      apiData.endpoints[groupKey] = [];
    }
    apiData.endpoints[groupKey].push(syntheticRequest);
    apiData.requests.push(syntheticRequest);
    existingKeys.add(key);
  }

  return apiData;
}
