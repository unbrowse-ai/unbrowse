/**
 * HAR Parser — Extract API endpoints and metadata from HAR files.
 *
 * Ported from meta_learner_simple.py parse_har() + group_by_domain_and_path().
 */

import type { HarEntry, ParsedRequest, ApiData } from "./types.js";
import { guessAuthMethod, isAuthLikeHeader } from "./auth-extractor.js";
import { normalizePath } from "./path-normalizer.js";
import { safeParseJson, inferSchema, getTopLevelSchema } from "./schema-inferrer.js";
import { analyzeEndpoints } from "./endpoint-analyzer.js";
import { isNoiseEndpoint } from "./noise-filter.js";

/** Static asset extensions to skip. */
const STATIC_EXTS = [
  // Styles & scripts
  ".css", ".js", ".map",
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".avif", ".bmp",
  // Fonts
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  // Video & audio
  ".webm", ".mp4", ".mov", ".avi", ".mp3", ".ogg", ".wav", ".flac",
  // Archives & binaries
  ".pdf", ".zip", ".gz", ".tar", ".dmg", ".exe", ".msi", ".wasm",
];

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

/** Standard browser headers that are NOT custom API auth. */
const STANDARD_HEADERS = new Set([
  "x-requested-with", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-proto", "x-real-ip", "x-frame-options",
  "x-content-type-options", "x-xss-protection", "x-ua-compatible",
  "x-dns-prefetch-control", "x-download-options", "x-permitted-cross-domain-policies",
  "x-powered-by", "x-request-id", "x-correlation-id", "x-trace-id",
]);

/** Check if a header is a standard (non-auth) header. */
function isStandardHeader(name: string): boolean {
  return STANDARD_HEADERS.has(name.toLowerCase());
}

/** HTTP/2 pseudo-headers that must be filtered out before replay.
 * These are protocol-level headers handled by the HTTP library, not application headers.
 * Sending them as regular headers causes "invalid header" errors. */
const HTTP2_PSEUDO_HEADERS = new Set([
  ":authority", ":method", ":path", ":scheme", ":status",
  ":protocol", // WebSocket over HTTP/2
]);

/** Check if a header is an HTTP/2 pseudo-header (starts with :). */
function isHttp2PseudoHeader(name: string): boolean {
  return name.startsWith(":") || HTTP2_PSEUDO_HEADERS.has(name.toLowerCase());
}

/** Context header names to capture (IDs, tenant info). */
const CONTEXT_HEADER_NAMES = new Set([
  "outletid", "userid", "supplierid", "companyid",
]);

/** Path prefixes to skip (infra noise on any domain). */
const SKIP_PATHS = [
  "/cdn-cgi/", "/_next/data/", "/_next/static/", "/__nextjs", "/sockjs-node/",
  "/favicon", "/manifest.json", "/robots.txt", "/sitemap",
  "/static/", "/assets/", "/precache-images",
];

/** Check if a URL is a static asset or infra noise. */
function isStaticAsset(url: string): boolean {
  const path = new URL(url).pathname.toLowerCase();
  if (STATIC_EXTS.some((ext) => path.endsWith(ext))) return true;
  if (SKIP_PATHS.some((prefix) => path.startsWith(prefix))) return true;
  return false;
}

/** Check if a response content-type indicates non-API content (media, fonts, css, binary). */
function isNonApiContentType(mimeType?: string): boolean {
  if (!mimeType) return false;
  const mt = mimeType.toLowerCase();
  if (mt.startsWith("image/")) return true;
  if (mt.startsWith("video/")) return true;
  if (mt.startsWith("audio/")) return true;
  if (mt.startsWith("font/") || mt.includes("font")) return true;
  if (mt === "text/css") return true;
  if (mt === "application/wasm") return true;
  if (mt === "application/octet-stream") return true;
  if (mt === "application/pdf") return true;
  if (mt === "application/zip") return true;
  return false;
}

/** Check if a domain should be skipped (third-party). */
function isSkippedDomain(domain: string): boolean {
  return SKIP_DOMAINS.some((skip) => domain.includes(skip));
}

/** Check if a URL looks like an API call. */
function isApiLike(url: string, method: string, domain: string, contentType?: string): boolean {
  // JSON responses are API calls regardless of URL pattern
  if (contentType && (contentType.includes("application/json") || contentType.includes("text/json"))) {
    return true;
  }
  
  return (
    url.includes("/api/") ||
    url.includes("/services/") ||
    url.includes("/v1/") ||
    url.includes("/v2/") ||
    url.includes("/v3/") ||
    url.includes("/graphql") ||
    url.includes("/order") ||    // trading APIs
    url.includes("/quote") ||    // trading APIs
    url.includes("/swap") ||     // trading APIs
    url.includes("/tokens") ||   // token APIs
    url.includes("/markets") ||  // market APIs
    url.includes("/user") ||     // user APIs
    url.includes("/auth") ||     // auth APIs
    ["POST", "PUT", "DELETE", "PATCH"].includes(method) ||
    // Allow any non-static on target domains that passed third-party filter
    domain.includes("api.") ||
    domain.includes("service") ||
    domain.includes("quote") ||  // quote-api.dflow.net etc
    domain.startsWith("dev-")    // dev-quote-api.dflow.net etc
  );
}

/** Extract root domain from a hostname (e.g., "api.dflow.net" -> "dflow.net") */
function getRootDomain(domain: string): string {
  const parts = domain.split(".");
  // Handle cases like "co.uk", "com.sg" etc.
  if (parts.length >= 2) {
    return parts.slice(-2).join(".");
  }
  return domain;
}

/** Check if two domains share the same root (e.g., "api.dflow.net" and "pond.dflow.net") */
function isSameRootDomain(domain1: string, domain2: string): boolean {
  return getRootDomain(domain1) === getRootDomain(domain2);
}

/**
 * Detect if a request is a GraphQL persisted query.
 * These use URL patterns like /api/v3/OperationName/hexHash with operationName query param.
 */
function detectGraphqlPersistedQuery(
  pathname: string,
  queryParams: { name: string; value: string }[],
  requestBody: unknown,
  responseBody: unknown,
): { operationName: string; queryHash?: string; basePath: string } | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  // Signal 1: operationName query param
  const opNameParam = queryParams.find((q) => q.name === "operationName");

  // Signal 2: Path pattern — look for a PascalCase/camelCase word followed by a long hex hash
  // e.g. /api/v3/AutoSuggestionsQuery/fd31e16424decce319...
  let pathOperationName: string | undefined;
  let pathHash: string | undefined;
  let basePath: string | undefined;

  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const nextSeg = segments[i + 1];
    // Operation name: starts with uppercase letter, contains only word chars, not a version prefix
    const isOperationName = /^[A-Z][a-zA-Z0-9]+$/.test(seg) && seg.length >= 3;
    // Next segment is a long hex hash (persisted query ID)
    const isHexHash = /^[0-9a-f]{32,}$/i.test(nextSeg);

    if (isOperationName && isHexHash) {
      pathOperationName = seg;
      pathHash = nextSeg;
      basePath = "/" + segments.slice(0, i).join("/");
      break;
    }
  }

  // Signal 3: Response has GraphQL envelope shape {data, extensions}
  let hasGraphqlEnvelope = false;
  if (responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)) {
    const keys = Object.keys(responseBody as Record<string, unknown>);
    hasGraphqlEnvelope = keys.includes("data") && (keys.includes("extensions") || keys.length <= 3);
  }

  // Signal 4: Request body has GraphQL structure
  let bodyOperationName: string | undefined;
  if (requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)) {
    const body = requestBody as Record<string, unknown>;
    if (typeof body.operationName === "string") {
      bodyOperationName = body.operationName;
    }
  }

  // Determine operation name from best source
  const operationName = opNameParam?.value || pathOperationName || bodyOperationName;
  if (!operationName) return null;

  // Need at least 2 signals to confirm GraphQL persisted query
  const signals = [
    !!opNameParam,
    !!pathOperationName,
    hasGraphqlEnvelope,
    !!bodyOperationName,
  ].filter(Boolean).length;

  if (signals < 2) return null;

  return {
    operationName,
    queryHash: pathHash,
    basePath: basePath || "/" + segments.slice(0, -1).join("/"),
  };
}

/** Group requests by domain:path. */
function groupByDomainAndPath(requests: ParsedRequest[]): Record<string, ParsedRequest[]> {
  const grouped: Record<string, ParsedRequest[]> = {};
  for (const req of requests) {
    // GraphQL operations collapse to their base path
    const path = req.graphqlOperation ? req.graphqlOperation.basePath : req.path;
    const key = `${req.domain}:${path}`;
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

    // Skip non-API content types (images, video, audio, fonts, css, binary)
    if (responseContentType && isNonApiContentType(responseContentType)) {
      continue;
    }

    // Skip noise endpoints (tracking, analytics, telemetry, asset manifests)
    // Uses generalized multi-signal scoring, not hardcoded paths
    if (isNoiseEndpoint({
      url,
      method,
      path: parsed.pathname,
      requestContentType: entry.request.postData?.mimeType,
      requestBodyText: entry.request.postData?.text,
      responseStatus,
      responseContentType,
      responseSize: entry.response?.content?.size,
      responseBodyText: entry.response?.content?.text,
    })) {
      continue;
    }

    // Check if this domain is related to the seed domain (same root, e.g., api.dflow.net for dflow.net)
    const isSeedRelated = seedDomain && isSameRootDomain(domain, seedDomain);

    // Only keep API-like requests (or allow all if on a known target domain or seed-related)
    const isTargetDomain = targetDomains.has(domain) || isSeedRelated;
    if (!isApiLike(url, method, domain, responseContentType) && targetDomains.size > 0 && !isTargetDomain) {
      continue;
    }

    targetDomains.add(domain);
    baseUrls.add(`${parsed.protocol}//${parsed.host}`);

    // Extract auth headers - use heuristic matching to catch custom auth headers
    for (const header of entry.request.headers ?? []) {
      const name = header.name.toLowerCase();
      const value = header.value;

      // Skip HTTP/2 pseudo-headers (e.g., :authority, :method, :path, :scheme)
      // These are protocol-level headers that break when replayed as regular headers
      if (isHttp2PseudoHeader(name)) {
        continue;
      }

      // Check if this looks like an auth header (exact match or pattern match)
      if (isAuthLikeHeader(name)) {
        authHeaders[name] = value;
        authInfo[`request_header_${name}`] = value;
      }

      if (CONTEXT_HEADER_NAMES.has(name)) {
        authInfo[`request_header_${name}`] = value;
      }

      // Also capture any custom x-* headers that aren't standard browser headers
      // These often contain API-specific auth or context
      if (name.startsWith("x-") && !isStandardHeader(name) && value) {
        if (!authInfo[`request_header_${name}`]) {
          authInfo[`request_header_${name}`] = value;
        }
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

    // ── Enrich: extract bodies, normalize path ────────────────────────────
    const queryParams = entry.request.queryString ?? [];

    let requestBody: unknown = undefined;
    let requestContentType: string | undefined = undefined;
    if (["POST", "PUT", "PATCH"].includes(method) && entry.request.postData?.text) {
      requestBody = safeParseJson(entry.request.postData.text);
      requestContentType = entry.request.postData.mimeType;
    }

    let responseBody: unknown = undefined;
    let responseSummary: string | undefined = undefined;
    const rawResponseText = entry.response?.content?.text;
    if (rawResponseText) {
      const parsedResponse = safeParseJson(rawResponseText);
      if (parsedResponse !== null) {
        responseBody = getTopLevelSchema(parsedResponse);
        responseSummary = inferSchema(parsedResponse).summary;
      }
    }

    const { normalizedPath, pathParams } = normalizePath(parsed.pathname);

    // Detect GraphQL persisted queries (e.g. /api/v3/OperationName/hexHash)
    const graphqlOp = detectGraphqlPersistedQuery(
      parsed.pathname, queryParams, requestBody, responseBody,
    );

    requests.push({
      method,
      url,
      path: parsed.pathname,
      domain,
      status: responseStatus,
      responseContentType,
      queryParams: queryParams.length > 0 ? queryParams : undefined,
      requestBody,
      requestContentType,
      responseBody,
      responseSummary,
      normalizedPath: graphqlOp ? graphqlOp.basePath : normalizedPath,
      pathParams: graphqlOp ? undefined : (pathParams.length > 0 ? pathParams : undefined),
      graphqlOperation: graphqlOp ?? undefined,
    });
  }

  // Determine service name and base URL.
  // Priority: API subdomain (like quote-api.x.com) > seed URL domain > most-common domain
  let service = "unknown-api";
  let baseUrl = "https://api.example.com";

  // Find the best API domain - prefer api/quote/service subdomains over the main site
  const findBestApiDomain = (): string | undefined => {
    const apiDomains = [...targetDomains].filter(d => 
      d.includes("api.") || d.includes("quote") || d.includes("service") || d.startsWith("dev-")
    );
    if (apiDomains.length > 0) {
      // Prefer domains with most requests
      const domainCounts: Record<string, number> = {};
      for (const req of requests) {
        if (apiDomains.includes(req.domain)) {
          domainCounts[req.domain] = (domainCounts[req.domain] ?? 0) + 1;
        }
      }
      return Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    }
    return undefined;
  };

  const bestApiDomain = findBestApiDomain();
  
  if (bestApiDomain && seedDomain && isSameRootDomain(bestApiDomain, seedDomain)) {
    // Found an API subdomain of the seed domain - use it as the base URL
    service = deriveServiceName(seedDomain);
    baseUrl = `https://${bestApiDomain}`;
  } else if (seedDomain) {
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

/**
 * Enrich parsed API data with endpoint analysis.
 *
 * Runs the endpoint analyzer to populate `data.endpointGroups` with
 * categorized, described, dependency-ordered endpoint groups.
 *
 * This is a separate post-processing step — call it after parseHar()
 * and optionally after mergeOpenApiEndpoints().
 */
export function enrichApiData(data: ApiData): ApiData {
  data.endpointGroups = analyzeEndpoints(data.requests, data.endpoints);
  return data;
}
