import type { RawRequest, CapturedWsMessage } from "../capture/index.js";
import type { EndpointDescriptor, WsMessage } from "../types/index.js";
import { inferSchema } from "../transform/index.js";
import { getRegistrableDomain } from "../domain.js";
import { nanoid } from "nanoid";

const SKIP_EXTENSIONS = /\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map|webp|html|avif)([?#]|$)/i;
const SKIP_JS_BUNDLES = /\/(boq-|_\/mss\/|og\/_\/js\/|_\/scs\/)/i;
const SKIP_PATHS = /\/_next\/static\/|\/_next\/data\/|\/_next\/image|\/static\/chunks\/|\/static\/media\/|\/cdn-cgi\//i;

// Known infrastructure/auth hosts — never useful as skill endpoints
const SKIP_HOSTS = /(cloudflare\.com|google-analytics\.com|doubleclick\.net|gstatic\.com|accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|appleid\.apple\.com|github\.com\/login|facebook\.com\/login|protechts\.net|demdex\.net|litms|platform-telemetry|datadoghq\.com|fullstory\.com|launchdarkly\.com|intercom\.io|privy\.io|mypinata\.cloud|sentry\.io|segment\.io|amplitude\.com|mixpanel\.com|hotjar\.com|clarity\.ms|googletagmanager\.com|walletconnect\.com|imagedelivery\.net|cloudflareinsights\.com)/i;

// Google-specific telemetry, ads, and infrastructure subdomains (BUG-GC-004)
const SKIP_TELEMETRY_HOSTS = /(waa-pa\.|signaler-pa\.|appsgrowthpromo-pa\.|ogads-pa\.|peoplestackwebexperiments-pa\.)/i;

// Known telemetry/logging path patterns
const SKIP_TELEMETRY_PATHS = /\/(log|logging|telemetry|analytics|beacon|ping|heartbeat|metrics)(\/|$)/i;

// RPC/API path hints — tightened to avoid false positives (BUG-GC-004)
const RPC_HINTS = /(\/$rpc\/|\/rpc\/|graphql|trending|search|feed|results|batchexecute|\/api\/)/i;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Headers that must never be stored in skill manifests (BUG-GC-005)
// Includes session tokens, API keys, and Google-specific credential headers.
const STRIP_HEADERS = new Set([
  "cookie",
  "authorization",
  "x-csrf-token",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-app-key",
  "x-app-secret",
  "content-length",
  "host",
  // Google credential headers
  "x-goog-api-key",
  "x-server-token",
  "x-goog-encode-response-if-executable",
  "x-clientdetails",
  "x-javascript-user-agent",
]);
// Also strip any header matching these prefixes
const STRIP_HEADER_PREFIXES = [
  "x-goog-auth", "x-goog-spatula",
  "x-auth-",          // generic auth headers
  "x-amz-security-",  // AWS security tokens
  "x-stripe-",        // Stripe API headers
  "x-firebase-",      // Firebase auth headers
];

// Headers known to be safe (non-sensitive) — used by the catch-all filter below
const SAFE_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control",
  "content-type", "origin", "referer", "user-agent", "pragma",
  "if-none-match", "if-modified-since", "range", "dnt", "connection",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site",
  "x-requested-with",
]);

// Patterns that indicate a header contains credentials — catch-all safety net
const SENSITIVE_HEADER_PATTERN = /token|key|secret|credential|password|session/i;

// Query param names that likely contain credentials and must be stripped from URL templates
const SENSITIVE_QUERY_PARAMS = /^(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret|password|key|token|session[_-]?id|client[_-]?secret|private[_-]?key|bearer)$/i;

// Framework-internal query params — noise from Next.js RSC, cache busting, etc.
const FRAMEWORK_QUERY_PARAMS = /^(_rsc|_next|__next|_t|_hash|__cf_chl_tk|nxtP\[.*\])$/i;

// Ad/tracking hosts that slip through the main SKIP_HOSTS filter
const AD_HOSTS = /buysellads\.com|carbonads\.com|ethicalads\.io|srv\.buysellads\.com|facet-futures\./i;

// Schema-level ad/tracking detection — if a response body's top-level keys
// match advertising vocabulary, the endpoint is an ad server regardless of host.
const AD_SCHEMA_KEYS = new Set([
  "campaignid", "creativeid", "creativetype", "creativecontent",
  "orderid", "impressionurl", "clickurl", "customerid",
  "adunitid", "adslot", "adsize", "lineitemid",
]);
const AD_SCHEMA_THRESHOLD = 3; // need at least this many ad-like keys to classify

function looksLikeAdResponse(body: string | undefined): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body);
    const keys = collectKeysShallow(parsed);
    let hits = 0;
    for (const k of keys) {
      if (AD_SCHEMA_KEYS.has(k.toLowerCase())) hits++;
    }
    return hits >= AD_SCHEMA_THRESHOLD;
  } catch {
    return false;
  }
}

/** Collect top-level + one-level-nested keys from an object/array */
function collectKeysShallow(obj: unknown): string[] {
  const keys: string[] = [];
  if (obj && typeof obj === "object") {
    const items = Array.isArray(obj) ? obj.slice(0, 3) : [obj];
    for (const item of items) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const k of Object.keys(item as Record<string, unknown>)) {
          keys.push(k);
          const val = (item as Record<string, unknown>)[k];
          if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object" && val[0]) {
            keys.push(...Object.keys(val[0] as Record<string, unknown>));
          }
        }
      }
    }
  }
  return keys;
}

// Score a request: higher = more likely to be a real data API (BUG-GC-004)
function scoreRequest(req: RawRequest): number {
  let score = 0;
  // GET is preferred — safe, idempotent, more useful for data retrieval
  if (req.method === "GET") score += 2;
  if (RPC_HINTS.test(req.url)) score += 3;
  if (SKIP_JS_BUNDLES.test(req.url)) score -= 10;
  const ct = req.response_headers?.["content-type"] ?? "";
  if (ct.includes("application/json") && !ct.includes("protobuf")) score += 4;
  // Protobuf responses are not parseable — score neutral, don't reward (BUG-GC-006)
  if (ct.includes("x-protobuf") || ct.includes("json+protobuf")) score += 0;
  if (req.url.length > 500) score -= 5;
  // Penalise telemetry paths even if they passed the host filter
  if (SKIP_TELEMETRY_PATHS.test(new URL(req.url).pathname)) score -= 8;
  // Penalise Next.js RSC navigation requests — framework wire format, not data
  if (req.url.includes("_rsc=")) score -= 3;
  if (ct.includes("text/x-component")) score -= 10; // RSC wire format
  return score;
}

export interface ExtractionContext {
  /** The page URL that was captured (used to detect entity values in API paths) */
  pageUrl?: string;
  /** The user's intent string */
  intent?: string;
}

export function extractEndpoints(requests: RawRequest[], wsMessages?: CapturedWsMessage[], context?: ExtractionContext): EndpointDescriptor[] {
  const seen = new Set<string>();
  const endpoints: EndpointDescriptor[] = [];

  // Extract the registrable domain for affinity filtering
  // e.g. "swaggystocks.com" from "https://swaggystocks.com/dashboard/..."
  let baseDomain: string | undefined;
  try { baseDomain = context?.pageUrl ? getRegistrableDomain(new URL(context.pageUrl).hostname) : undefined; } catch { /* bad url */ }

  const scored = requests
    .map((r) => ({ req: r, score: scoreRequest(r) }))
    .filter(({ req, score }) => isApiLike(req) && score > 0)
    .filter(({ req }) => {
      if (!baseDomain) return true; // no target domain — keep everything
      try {
        const reqHost = new URL(req.url).hostname;
        const reqDomain = getRegistrableDomain(reqHost);
        // Keep same-domain and API subdomains (e.g. api.swaggystocks.com)
        return reqDomain === baseDomain;
      } catch { return false; }
    })
    .sort((a, b) => b.score - a.score);

  for (const { req } of scored) {
    const normalized = normalizeUrl(req.url);
    const key = `${req.method}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Schema-level ad detection: skip endpoints whose response body looks like ad-server data
    if (looksLikeAdResponse(req.response_body)) continue;

    // BUG-008: Detect Cloudflare challenge responses — exclude from skill
    if (isCloudflareChallenge(req.response_body)) continue;

    // BUG-GC-006: Skip protobuf-only endpoints — we can't parse their bodies
    const ct = req.response_headers?.["content-type"] ?? "";
    if ((ct.includes("x-protobuf") || ct.includes("json+protobuf")) && !isJsonParseable(req.response_body)) continue;

    const isGet = req.method === "GET";

    // Infer response schema from captured body
    let response_schema = undefined;
    if (req.response_body) {
      try {
        const cleaned = stripJsonPrefix(req.response_body);
        const parsed = JSON.parse(cleaned);
        response_schema = inferSchema([parsed]);
      } catch {
        // not valid JSON — skip schema inference
      }
    }

    // BUG-008: mark endpoints with no response body as potentially CF-blocked
    const verificationStatus = req.response_body ? "unverified" as const : "pending" as const;

    // Skip endpoints with invalid URL templates
    if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) continue;

    // Build url_template with templatized query params so callers know what to pass.
    // normalizeUrl strips the query string; we rebuild it with {param} placeholders.
    // endpoint.query stores the captured defaults for execution-time fallback.
    const sanitizedQParams = isGet ? sanitizeQueryParams(extractQueryParams(req.url)) : undefined;
    let pathTemplate = sanitizeUrlTemplate(normalized);
    const qTemplateStr = sanitizedQParams && Object.keys(sanitizedQParams).length > 0
      ? Object.keys(sanitizedQParams).map((k) => `${encodeURIComponent(k)}={${k}}`).join("&")
      : null;

    // BUG-006: Parameterize dynamic path segments (comma lists, page URL entities)
    const { url: templatizedPath, pathParams } = templatizePathSegments(pathTemplate, req.url, context);
    pathTemplate = templatizedPath;

    endpoints.push({
      endpoint_id: nanoid(),
      method: req.method as EndpointDescriptor["method"],
      url_template: qTemplateStr ? `${pathTemplate}?${qTemplateStr}` : pathTemplate,
      headers_template: sanitizeHeaders(req.request_headers),
      query: sanitizedQParams,
      path_params: Object.keys(pathParams).length > 0 ? pathParams : undefined,
      body: !isGet && req.request_body ? tryParseBody(req.request_body) : undefined,
      idempotency: isGet ? "safe" : "unsafe",
      verification_status: verificationStatus,
      reliability_score: 0.5,
      response_schema,
      // Record which page triggered this API call — used for trigger-and-intercept execution
      trigger_url: context?.pageUrl,
    });
  }

  // Collapse sibling endpoints into templatized ones
  // e.g. /ticker-sentiment/MSFT + /ticker-sentiment/NVDA → /ticker-sentiment/{ticker}
  const deduped = collapseEndpoints(endpoints);
  endpoints.length = 0;
  endpoints.push(...deduped);

  // Create endpoints from WebSocket messages
  if (wsMessages && wsMessages.length > 0) {
    const wsByUrl = new Map<string, CapturedWsMessage[]>();
    for (const msg of wsMessages) {
      const arr = wsByUrl.get(msg.url) ?? [];
      arr.push(msg);
      wsByUrl.set(msg.url, arr);
    }

    for (const [wsUrl, msgs] of wsByUrl) {
      const received = msgs.filter((m) => m.direction === "received");
      const wsMsgList: WsMessage[] = msgs.map((m) => ({
        direction: m.direction,
        data: m.data,
        timestamp: m.timestamp,
      }));

      // Try to infer response schema from first few received JSON messages
      let response_schema = undefined;
      const jsonSamples: unknown[] = [];
      for (const m of received.slice(0, 5)) {
        try {
          jsonSamples.push(JSON.parse(m.data));
        } catch { /* not JSON */ }
      }
      if (jsonSamples.length > 0) {
        response_schema = inferSchema(jsonSamples);
      }

      endpoints.push({
        endpoint_id: nanoid(),
        method: "WS",
        url_template: wsUrl,
        idempotency: "safe",
        verification_status: "unverified",
        reliability_score: jsonSamples.length > 0 ? 0.7 : 0.3,
        response_schema,
        ws_messages: wsMsgList,
      });
    }
  }

  return endpoints;
}

function isApiLike(req: RawRequest): boolean {
  if (!ALLOWED_METHODS.has(req.method.toUpperCase())) return false;
  if (SKIP_EXTENSIONS.test(req.url)) return false;
  if (SKIP_JS_BUNDLES.test(req.url)) return false;
  if (SKIP_PATHS.test(req.url)) return false;
  try {
    const { hostname, pathname } = new URL(req.url);
    if (SKIP_HOSTS.test(hostname)) return false;
    if (SKIP_TELEMETRY_HOSTS.test(hostname)) return false;  // BUG-GC-004
    if (SKIP_TELEMETRY_PATHS.test(pathname)) return false;  // BUG-GC-004
    if (AD_HOSTS.test(hostname)) return false;
    // play.google.com/log is telemetry, not calendar data
    if (hostname === "play.google.com" && pathname.startsWith("/log")) return false;
    // Skip image CDN paths (coin images, avatars, etc.)
    if (/\/(coin-image|avatar|profile-image)\//.test(pathname)) return false;
  } catch {
    return false;
  }
  return true;
}

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/{id}")
      .replace(/\/\d{4,}/g, "/{id}")
      .replace(/\/[a-f0-9]{24,}/gi, "/{id}")
      // URN identifiers (e.g. urn:li:fsd_profile:ACoAAB3fei4B...)
      .replace(/\/urn:[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)+/g, "/{urn}")
      // BUG-006: Comma-separated values are lists of identifiers (e.g. SPY,QQQ)
      .replace(/\/([A-Za-z0-9_-]+(?:,[A-Za-z0-9_-]+)+)(?=\/|$)/g, "/{list}");
    // Preserve queryId param for GraphQL endpoints so different queries aren't deduplicated
    const queryId = u.searchParams.get("queryId");
    if (queryId && path.includes("graphql")) {
      return `${u.origin}${path}?queryId=${queryId}`;
    }
    return `${u.origin}${path}`;
  } catch {
    return rawUrl;
  }
}

function extractQueryParams(rawUrl: string): Record<string, string> {
  try {
    const u = new URL(rawUrl);
    const params: Record<string, string> = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    return params;
  } catch {
    return {};
  }
}

/** Returns true if a header name is sensitive and should be stripped from skill manifests. */
function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "cookie" || lower === "content-length" || lower === "host") return false; // handled separately
  if (STRIP_HEADERS.has(lower)) return true;
  if (STRIP_HEADER_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (lower.startsWith("x-goog-api")) return true;
  if (lower.startsWith("x-server-")) return true;
  if (!SAFE_HEADERS.has(lower) && SENSITIVE_HEADER_PATTERN.test(lower)) return true;
  return false;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([k]) => {
      const lower = k.toLowerCase();
      if (lower === "cookie" || lower === "content-length" || lower === "host") return false;
      return !isSensitiveHeader(k);
    })
  );
}

/**
 * Extract auth-sensitive headers from captured requests — the inverse of sanitizeHeaders.
 * These are stored in the vault (not the skill manifest) so server-fetch can reconstruct
 * the full header set without launching a browser. This is what makes the 2nd call fast.
 */
export function extractAuthHeaders(requests: RawRequest[]): Record<string, string> {
  const authHeaders: Record<string, string> = {};
  for (const req of requests) {
    for (const [k, v] of Object.entries(req.request_headers)) {
      const lower = k.toLowerCase();
      if (lower === "cookie" || lower === "content-length" || lower === "host") continue;
      if (isSensitiveHeader(k) && !authHeaders[lower]) {
        authHeaders[lower] = v;
      }
    }
  }
  return authHeaders;
}

function sanitizeQueryParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params).filter(([k]) =>
      !SENSITIVE_QUERY_PARAMS.test(k) && !FRAMEWORK_QUERY_PARAMS.test(k)
    )
  );
}

function sanitizeUrlTemplate(url: string): string {
  try {
    const u = new URL(url);
    if (u.search.length <= 1) return url;
    const cleaned = new URLSearchParams();
    for (const [key, val] of u.searchParams) {
      if (!SENSITIVE_QUERY_PARAMS.test(key) && !FRAMEWORK_QUERY_PARAMS.test(key)) {
        cleaned.set(key, val);
      }
    }
    const qs = cleaned.toString();
    // Use the raw URL path (not u.pathname) to preserve {template} braces
    const pathMatch = url.match(/^https?:\/\/[^/]+(\/[^?]*)/);
    const rawPath = pathMatch ? pathMatch[1] : u.pathname;
    return qs ? `${u.origin}${rawPath}?${qs}` : `${u.origin}${rawPath}`;
  } catch {
    return url;
  }
}

// ── BUG-006: Path segment parameterization ──────────────────────────────────

/** Extract entity-like values from the page URL that may appear in API paths */
function extractEntityHints(context?: ExtractionContext): Set<string> {
  const hints = new Set<string>();
  if (!context?.pageUrl) return hints;
  try {
    const u = new URL(context.pageUrl);
    for (const seg of u.pathname.split("/").filter(Boolean)) {
      // Skip structural path parts
      if (/^(en|es|fr|de|ja|zh|ko|api|v\d+|www|static|assets|public|pages|app)$/i.test(seg)) continue;
      if (seg.length > 40 || seg.length < 2) continue;
      hints.add(seg.toLowerCase());
    }
  } catch { /* skip */ }
  return hints;
}

/**
 * Infer a meaningful param name from the preceding path segment.
 * e.g. /quote/{?} → {quote}, /coins/{?} → {coin}, /price_charts/{?} → {price_chart}
 */
function inferParamName(segments: string[], index: number, fallback: string, usedNames: Set<string>): string {
  let name = fallback;
  const prev = segments[index - 1];
  if (prev && !prev.startsWith("{") && prev.length > 1) {
    // Naive singularize: "coins" → "coin", "charts" → "chart"
    const base = prev.endsWith("s") && prev.length > 3 ? prev.slice(0, -1) : prev;
    name = base.replace(/[^a-zA-Z0-9_]/g, "_");
  }
  // Ensure uniqueness
  let unique = name;
  let counter = 2;
  while (usedNames.has(unique)) {
    unique = `${name}_${counter++}`;
  }
  usedNames.add(unique);
  return unique;
}

/**
 * BUG-006: Parameterize dynamic path segments in API URL templates.
 *
 * Two detection strategies:
 * 1. Comma-separated values (already collapsed to {list} by normalizeUrl) — capture defaults
 * 2. Context-aware: segments matching entity values from the page URL
 *
 * Returns the templatized URL and a map of param names → captured default values.
 * NOTE: Avoids `new URL()` on the template since it would percent-encode curly braces.
 */
function templatizePathSegments(
  templateUrl: string,
  originalUrl: string,
  context?: ExtractionContext,
): { url: string; pathParams: Record<string, string> } {
  const pathParams: Record<string, string> = {};

  try {
    // Parse templateUrl manually to avoid encoding {braces}
    // Format: "https://host:port/path/segments" (query already stripped by normalizeUrl)
    const tMatch = templateUrl.match(/^(https?:\/\/[^/]+)(\/.*)?$/);
    if (!tMatch) return { url: templateUrl, pathParams };
    const tOrigin = tMatch[1];
    const tPath = tMatch[2] ?? "/";

    const oPath = new URL(originalUrl).pathname;

    const tSegments = tPath.split("/");
    const oSegments = oPath.split("/");
    const hints = extractEntityHints(context);
    const usedNames = new Set<string>();

    for (let i = 0; i < tSegments.length; i++) {
      const tSeg = tSegments[i];
      const oSeg = oSegments[i] ?? tSeg;

      if (!tSeg) continue;

      // Pattern 1: Already parameterized by normalizeUrl ({id}, {list}, {urn}) — capture defaults & rename
      if (tSeg === "{id}" || tSeg === "{list}" || tSeg === "{urn}") {
        const fallback = tSeg === "{list}" ? "list" : tSeg === "{urn}" ? "urn" : "id";
        const paramName = inferParamName(tSegments, i, fallback, usedNames);
        tSegments[i] = `{${paramName}}`;
        pathParams[paramName] = oSeg;
        continue;
      }

      // Skip segments that are already template vars, file extensions, or structural
      if (tSeg.startsWith("{")) continue;
      if (tSeg.includes(".")) continue; // e.g. "24_hours.json"
      if (/^(api|v\d+|www|en|es|fr|de|latest|dex|search)$/i.test(tSeg)) continue;

      // Pattern 2: Segment matches a page URL entity hint (case-insensitive)
      if (hints.size > 0 && hints.has(tSeg.toLowerCase())) {
        const paramName = inferParamName(tSegments, i, "slug", usedNames);
        tSegments[i] = `{${paramName}}`;
        pathParams[paramName] = oSeg;
        continue;
      }
    }

    return { url: `${tOrigin}${tSegments.join("/")}`, pathParams };
  } catch {
    return { url: templateUrl, pathParams };
  }
}

function isJsonParseable(body?: string): boolean {
  if (!body) return false;
  try { JSON.parse(stripJsonPrefix(body)); return true; } catch { return false; }
}

/** Strip Google/common API JSON prefixes like )]}'\n or )]}\n */
function stripJsonPrefix(body: string): string {
  return body.replace(/^\)?\]?\}?'?\s*\n/, "");
}

function tryParseBody(body: string): Record<string, unknown> | undefined {
  // Try JSON first
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {}

  // Try URL-encoded form data (BUG-GC-008: calendar sync endpoints use x-www-form-urlencoded)
  try {
    const params = new URLSearchParams(body);
    const result: Record<string, unknown> = {};
    params.forEach((v, k) => { result[k] = v; });
    if (Object.keys(result).length > 0) return result;
  } catch {}

  return undefined;
}


/**
 * Determine whether a URL path segment looks like a variable entity ID
 * (UUID, numeric ID, hash, ticker symbol) vs. a fixed action/resource name
 * (camelCase, English word, REST resource).
 *
 * Used by collapseEndpoints to avoid merging distinct API actions
 * like /relationships/connectionsSummary + /relationships/invitationsSummary.
 */
function looksLikeEntityId(segment: string): boolean {
  if (segment.startsWith("{")) return true;
  // UUID (with or without dashes)
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(segment)) return true;
  // Pure numeric
  if (/^\d+$/.test(segment)) return true;
  // Long hex string (hash, object ID) — 8+ hex chars
  if (/^[0-9a-f]{8,}$/i.test(segment)) return true;
  // URN identifiers
  if (segment.startsWith("urn:")) return true;
  // Short uppercase stock tickers (1-5 uppercase letters, possibly with dots like BRK.B)
  if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(segment)) return true;
  // Comma-separated lists
  if (segment.includes(",")) return true;

  // === NOT an entity ID — these are action/resource names ===
  // camelCase: lowercase letter followed by uppercase (e.g., connectionsSummary)
  if (/[a-z][A-Z]/.test(segment)) return false;
  // snake_case or kebab-case multi-word
  if (/[a-z][_-][a-z]/i.test(segment)) return false;
  // Pure lowercase alphabetic word 3+ chars (REST resource: "connections", "settings")
  if (/^[a-z]{3,}$/.test(segment)) return false;

  // Ambiguous — allow collapsing (conservative)
  return true;
}

/**
 * Collapse sibling endpoints that share the same base path into a single
 * templatized endpoint.  e.g.:
 *   GET /sentiment/MSFT  +  GET /sentiment/NVDA  +  GET /sentiment/HIMS
 *   → GET /sentiment/{ticker}
 *
 * Strategy: group endpoints by (method, origin, pathPrefix) where pathPrefix is
 * all path segments except the last.  If a group has 3+ members whose last
 * segment varies, replace the last segment with a template variable.
 * Keep the first endpoint's metadata (headers, schema, etc.) as representative.
 *
 * Only collapses when the majority (>50%) of varying segments look like entity
 * IDs, NOT distinct action/resource names (camelCase, REST words).
 */
function collapseEndpoints(endpoints: EndpointDescriptor[]): EndpointDescriptor[] {
  // Group by method + origin + all-but-last path segment
  const groups = new Map<string, EndpointDescriptor[]>();
  const ungrouped: EndpointDescriptor[] = [];

  for (const ep of endpoints) {
    try {
      const u = new URL(ep.url_template);
      const segments = u.pathname.split("/").filter(Boolean);
      if (segments.length < 2) {
        // Root or single-segment paths can't be collapsed
        ungrouped.push(ep);
        continue;
      }
      const prefix = segments.slice(0, -1).join("/");
      const key = `${ep.method}:${u.origin}/${prefix}`;
      const arr = groups.get(key) || [];
      arr.push(ep);
      groups.set(key, arr);
    } catch {
      ungrouped.push(ep);
    }
  }

  const result: EndpointDescriptor[] = [...ungrouped];

  for (const [key, group] of groups) {
    if (group.length < 3) {
      // Not enough siblings to justify templatizing — keep as-is
      result.push(...group);
      continue;
    }

    // Check that the last segments actually vary (not all identical)
    const lastSegments = group.map((ep) => {
      const u = new URL(ep.url_template);
      const segs = u.pathname.split("/").filter(Boolean);
      return segs[segs.length - 1];
    });
    const unique = new Set(lastSegments);
    if (unique.size < 3) {
      // Last segments don't vary enough — keep as-is
      result.push(...group);
      continue;
    }

    // Only collapse if the varying segments look like entity IDs (UUIDs, numbers,
    // tickers, hashes), NOT distinct action/resource names (camelCase, English words).
    const entityLikeCount = lastSegments.filter((s) => looksLikeEntityId(s)).length;
    if (entityLikeCount / lastSegments.length <= 0.5) {
      result.push(...group);
      continue;
    }

    // Infer a template variable name from the path prefix
    const [, prefixPath] = key.split(":", 2);
    const u = new URL(group[0].url_template);
    const prefix = u.pathname.split("/").filter(Boolean).slice(0, -1);
    const paramName = inferParamName(prefix, prefix.length, "id", new Set<string>());
    const templatizedPath = "/" + [...prefix, `{${paramName}}`].join("/");

    // Keep the first endpoint as representative, update its URL template
    const representative = { ...group[0] };
    representative.url_template = `${u.origin}${templatizedPath}`;
    // Merge all captured example values as a hint
    representative.query = {
      ...(representative.query || {}),
    };

    result.push(representative);
  }

  return result;
}

/**
 * BUG-008: Detect Cloudflare challenge/block responses.
 * CF challenge pages contain distinctive markers in the HTML body.
 */
function isCloudflareChallenge(responseBody?: string): boolean {
  if (!responseBody) return false;
  const CF_MARKERS = [
    "cf-error",
    "challenge-platform",
    "cf-chl-bypass",
    "Checking if the site connection is secure",
    "Enable JavaScript and cookies to continue",
    "cf_chl_opt",
    "jschl-answer",
    "_cf_chl_tk",
  ];
  const bodyLower = responseBody.toLowerCase();
  return CF_MARKERS.some((marker) => bodyLower.includes(marker.toLowerCase()));
}
