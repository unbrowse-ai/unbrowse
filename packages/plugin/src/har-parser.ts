/**
 * HAR Parser — Extract API endpoints and metadata from HAR files.
 *
 * Refactored into OOP: HarParser delegates to RouteNormalizer,
 * EndpointFingerprinter, TrafficFilter, and DomainDetector.
 *
 * Route normalization ported from backend har-similarity.ts + har-tools.ts.
 *
 * Ported from meta_learner_simple.py parse_har() + group_by_domain_and_path().
 */

import { createHash } from "node:crypto";
import type {
  HarEntry, ParsedRequest, ApiData,
  NormalizedEndpoint, EndpointFingerprint, EndpointGroup,
} from "./types.js";
import { guessAuthMethod, HeaderClassifier } from "./auth-extractor.js";
import { buildHeaderProfiles } from "./header-profiler.js";
import {
  safeParseJson, inferSchema, mergeSchemas, getTopLevelSchema,
  generateMethodName, generateEndpointDescription,
  type InferredSchema,
} from "./schema-inferrer.js";

// ---------------------------------------------------------------------------
// RouteNormalizer — generalize URL paths by replacing variable segments
// Ported from backend har-similarity.ts:136 and har-tools.ts:20
// Enhanced with context-aware detection from path-normalizer.ts
// ---------------------------------------------------------------------------

/** Static path segments that are never dynamic (API conventions). */
const STATIC_SEGMENTS = new Set([
  "api", "v1", "v2", "v3", "v4", "graphql", "rest", "rpc",
  "auth", "login", "logout", "signup", "register", "token", "refresh", "verify",
  "search", "filter", "sort", "export", "import", "bulk", "batch",
  "health", "status", "info", "version", "config", "settings", "preferences",
  "me", "self", "current", "public", "private", "internal", "admin",
  "list", "create", "update", "delete", "get", "set",
  "new", "edit", "view", "detail", "details", "summary",
  "count", "stats", "analytics", "metrics", "reports",
  "upload", "download", "index", "home", "dashboard",
  "venues", "trending", "featured", "popular", "latest", "recent",
  "topstories", "newstories", "beststories", "askstories", "showstories",
]);

/** Version-like path segments (v1, v2, v0, etc.) */
const VERSION_PATTERN = /^v\d+(\.\d+)*$/;

/** Singularize a segment name for parameter naming. */
function singularizeSegment(segment: string): string {
  if (segment.endsWith("ies")) {
    return segment.slice(0, -3) + "y";
  } else if (segment.endsWith("ses") || segment.endsWith("xes") || segment.endsWith("zes")) {
    return segment.slice(0, -2);
  } else if (segment.endsWith("s") && !segment.endsWith("ss") && segment.length > 2) {
    return segment.slice(0, -1);
  }
  return segment;
}

/** Detection patterns ordered by specificity. */
const PARAM_PATTERNS = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  timestamp: /^\d{10,13}$/,
  numeric: /^\d+$/,
  hex: /^[0-9a-f]{8,}$/i,
  slug: /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$/i,
  base64: /^[A-Za-z0-9+/]{16,}={0,2}$/,
  /** Mixed alphanumeric — letters AND digits, like "abc123" or "CS2030S" */
  mixedAlphaNum: /^[a-z0-9]{4,}$/i,
} as const;

export class RouteNormalizer {
  /**
   * Normalize a URL path by replacing variable segments (IDs, UUIDs, timestamps, etc.)
   * Uses context-aware detection: resource names, static segments, and pattern matching.
   *
   * Example: /users/123/profile -> /users/{userId}/profile
   * Example: /v2/2024-2025/modules/CS2030S.json -> /v2/{date}/{id}/modules/{moduleId}.json
   */
  normalizePath(path: string): { normalizedPath: string; pathParams: { name: string; type: string; example: string }[] } {
    const segments = path.split("/").filter(s => s.length > 0);
    const pathParams: { name: string; type: string; example: string }[] = [];
    const usedNames = new Set<string>();

    const normalized = segments.map((segment, i) => {
      // Strip file extensions for detection, but preserve them in output
      const ext = this.getExtension(segment);
      const bare = ext ? segment.slice(0, -ext.length) : segment;

      const paramType = this.detectParamType(bare);
      if (!paramType) {
        // Static segment — keep as-is (lowercased)
        return segment.toLowerCase();
      }

      let name = this.deriveParamName(segments, i, paramType);

      // Deduplicate names
      if (usedNames.has(name)) {
        let counter = 2;
        while (usedNames.has(`${name}${counter}`)) counter++;
        name = `${name}${counter}`;
      }
      usedNames.add(name);

      pathParams.push({ name, type: paramType, example: segment });
      return `{${name}}` + (ext ?? "");
    });

    return {
      normalizedPath: "/" + normalized.join("/"),
      pathParams,
    };
  }

  /**
   * Normalize a full URL path (including URL parsing).
   * Returns just the normalized path without domain.
   */
  normalizeUrlPath(url: string): string {
    try {
      const urlObj = new URL(url);
      const { normalizedPath } = this.normalizePath(urlObj.pathname);
      return normalizedPath;
    } catch {
      return url;
    }
  }

  /**
   * Detect the type of a dynamic path segment.
   * Returns null if the segment is a known static segment or doesn't match any pattern.
   */
  private detectParamType(segment: string): string | null {
    // Never replace version prefixes or known static segments
    if (VERSION_PATTERN.test(segment)) return null;
    if (STATIC_SEGMENTS.has(segment.toLowerCase())) return null;

    // Check patterns in order of specificity
    if (PARAM_PATTERNS.uuid.test(segment)) return "uuid";
    if (PARAM_PATTERNS.email.test(segment)) return "email";
    if (PARAM_PATTERNS.date.test(segment)) return "date";
    if (PARAM_PATTERNS.timestamp.test(segment)) return "timestamp";
    if (PARAM_PATTERNS.numeric.test(segment)) return "integer";
    if (PARAM_PATTERNS.hex.test(segment) && segment.length >= 8) return "hex";
    if (PARAM_PATTERNS.slug.test(segment) && segment.length >= 8) return "slug";
    if (PARAM_PATTERNS.base64.test(segment) && segment.length >= 16) return "base64";

    // Mixed alphanumeric (letters AND digits) — e.g. "CS2030S", "abc123"
    // Only parameterize if it contains both letters and digits
    if (PARAM_PATTERNS.mixedAlphaNum.test(segment) && /[a-z]/i.test(segment) && /\d/.test(segment)) {
      return "string";
    }

    // Academic year patterns like "2024-2025"
    if (/^\d{4}-\d{4}$/.test(segment)) return "academicYear";

    return null;
  }

  /**
   * Derive a parameter name from the preceding path segment using
   * resource-aware naming. Singularizes the previous segment for the name.
   *
   * /users/123 -> "userId"
   * /items/abc-def -> "itemId"
   * /modules/CS2030S -> "moduleId"
   */
  private deriveParamName(segments: string[], index: number, paramType: string): string {
    if (paramType === "email") return "email";
    if (paramType === "date") return "date";
    if (paramType === "timestamp") return "timestamp";
    if (paramType === "academicYear") return "academicYear";

    if (index <= 0) return "id";

    const prev = segments[index - 1].toLowerCase();
    // Strip file extension from previous segment
    const prevExt = this.getExtension(prev);
    const prevBare = prevExt ? prev.slice(0, -prevExt.length) : prev;

    // Singularize the previous segment + "Id"
    const singular = singularizeSegment(prevBare);
    return `${singular}Id`;
  }

  /** Known data file extensions that should be stripped for pattern detection. */
  private static readonly DATA_EXTENSIONS = new Set([
    ".json", ".xml", ".csv", ".yaml", ".yml", ".txt", ".html", ".htm",
    ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
  ]);

  /** Extract known data file extension from a segment (e.g., ".json" from "CS2030S.json"). */
  private getExtension(segment: string): string | undefined {
    const match = segment.match(/(\.[a-z]{2,5})$/i);
    if (!match) return undefined;
    // Only strip known data extensions — not domain TLDs like .com in emails
    return RouteNormalizer.DATA_EXTENSIONS.has(match[1].toLowerCase()) ? match[1] : undefined;
  }
}

// ---------------------------------------------------------------------------
// EndpointFingerprinter — create stable fingerprints for deduplication
// Ported from backend har-tools.ts createEndpointFingerprint
// ---------------------------------------------------------------------------

export class EndpointFingerprinter {
  private routeNormalizer: RouteNormalizer;

  constructor(routeNormalizer?: RouteNormalizer) {
    this.routeNormalizer = routeNormalizer ?? new RouteNormalizer();
  }

  /**
   * Create a comprehensive endpoint fingerprint for deduplication.
   * Combines: METHOD + normalized_path + query_params + body_structure
   */
  fingerprint(method: string, url: string, body?: string): EndpointFingerprint {
    const normalizedPath = this.routeNormalizer.normalizeUrlPath(url);
    const queryKeys = this.normalizeQueryParams(url);
    const bodySchema = this.normalizeBodyStructure(body);

    return { method: method.toUpperCase(), normalizedPath, queryKeys, bodySchema };
  }

  /** Serialize a fingerprint to a stable string for comparison/hashing. */
  toString(fp: EndpointFingerprint): string {
    const parts = [fp.method, fp.normalizedPath];
    if (fp.queryKeys.length > 0) parts.push(`query:${fp.queryKeys.join(",")}`);
    if (fp.bodySchema) parts.push(`body:${fp.bodySchema}`);
    return parts.join("|");
  }

  /**
   * Create a stable fingerprint for query parameters (order-independent).
   * Returns sorted param key names (values ignored — structure only).
   */
  normalizeQueryParams(url: string): string[] {
    try {
      const urlObj = new URL(url);
      return Array.from(urlObj.searchParams.keys()).sort();
    } catch {
      return [];
    }
  }

  /**
   * Create a stable fingerprint for request body structure (order-independent).
   * Extracts the schema/keys from the body, ignoring values.
   * Ported from backend har-tools.ts normalizeBodyStructure.
   */
  normalizeBodyStructure(body?: string): string {
    if (!body) return "";

    try {
      const parsed = JSON.parse(body);
      const keys = this.extractKeys(parsed);
      return keys.sort().join(",");
    } catch {
      // Not JSON — treat as opaque
      return body.length > 0 ? "string_body" : "";
    }
  }

  /** Recursively extract sorted key paths from a JSON object. */
  private extractKeys(obj: unknown, prefix = ""): string[] {
    if (!obj || typeof obj !== "object") return [];

    if (Array.isArray(obj)) {
      return obj.length > 0 ? this.extractKeys(obj[0], prefix + "[]") : [prefix + "[]"];
    }

    const keys: string[] = [];
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      keys.push(fullKey);
      const value = (obj as Record<string, unknown>)[key];
      if (value && typeof value === "object") {
        keys.push(...this.extractKeys(value, fullKey));
      }
    }
    return keys;
  }
}

// ---------------------------------------------------------------------------
// SchemaHasher — SHA-256 hash of request/response body structures
// ---------------------------------------------------------------------------

export class SchemaHasher {
  private fingerprinter: EndpointFingerprinter;

  constructor(fingerprinter?: EndpointFingerprinter) {
    this.fingerprinter = fingerprinter ?? new EndpointFingerprinter();
  }

  /** Hash the body schema structure to a short hex string. */
  hash(body?: string): string | undefined {
    const schema = this.fingerprinter.normalizeBodyStructure(body);
    if (!schema) return undefined;
    return createHash("sha256").update(schema).digest("hex").slice(0, 12);
  }
}

// ---------------------------------------------------------------------------
// TrafficFilter — filter static assets, third-party domains, noise
// ---------------------------------------------------------------------------

export class TrafficFilter {
  /** Static asset extensions to skip. */
  private static readonly STATIC_EXTS = [
    ".css", ".js", ".png", ".jpg", ".jpeg", ".gif", ".svg",
    ".woff", ".woff2", ".ico", ".map",
  ];

  /** Third-party domains to skip (analytics, payments, social, etc.). */
  private static readonly SKIP_DOMAINS = [
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
    // Auth providers (third-party SSO)
    "accounts.google.com", "play.google.com", "stack-auth.com", "api.stack-auth.com",
    // Cloudflare
    "cdn-cgi",
    // TikTok analytics
    "analytics.tiktok.com", "analytics-sg.tiktok.com", "mon.tiktokv.com",
    "mcs.tiktokw.com", "lf16-tiktok-web.tiktokcdn-us.com",
    // Google services
    "www.googletagmanager.com", "www.google.com", "google.com",
    "fonts.googleapis.com", "fonts.gstatic.com", "maps.googleapis.com",
    "www.gstatic.com", "apis.google.com", "ssl.gstatic.com",
    "pagead2.googlesyndication.com", "adservice.google.com",
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
    // Ad tech & programmatic
    "taboola.com", "trc.taboola.com", "cdn.taboola.com",
    "thetradedesk.com", "match.adsrvr.org", "adsrvr.org",
    "pubmatic.com", "ads.pubmatic.com", "image8.pubmatic.com",
    "criteo.com", "dis.criteo.com", "bidder.criteo.com",
    "rubiconproject.com", "fastlane.rubiconproject.com",
    "openx.net", "u.openx.net",
    "adnxs.com", "ib.adnxs.com",
    "casalemedia.com", "dpm.demdex.net", "demdex.net",
    "rlcdn.com", "ri.rlcdn.com",
    "bluekai.com", "stags.bluekai.com",
    "bidswitch.net", "x.bidswitch.net",
    "sharethrough.com", "btlr.sharethrough.com",
    "lijit.com", "ap.lijit.com",
    "indexexchange.com", "htlb.casalemedia.com",
    "crwdcntrl.net", "bcp.crwdcntrl.net",
    "eyeota.net", "ps.eyeota.net",
    "outbrain.com", "tr.outbrain.com",
    "quantserve.com", "pixel.quantserve.com",
    "adsymptotic.com",
    // Analytics & tracking (additional)
    "piwik.pro", "piwikpro.com",
    "mouseflow.com", "o2.mouseflow.com",
    "crazyegg.com",
    "smartlook.com",
    "luckyorange.com",
    // Consent & GDPR
    "privacy-center.org", "consentframework.com",
    "quantcast.com", "quantcount.com",
    "trustarc.com", "consent.trustarc.com",
    // Social & commenting
    "disqus.com", "disquscdn.com",
    // User sync & identity
    "usersync.org", "sync.outbrain.com",
    "eus.rubiconproject.com", "pixel.rubiconproject.com",
    "ad.doubleclick.net",
    // CDN / static assets (third-party)
    "bootstrapcdn.com", "maxcdn.bootstrapcdn.com",
  ];

  /** Path prefixes to skip (infra noise on any domain). */
  private static readonly SKIP_PATHS = [
    "/cdn-cgi/", "/_next/data/", "/__nextjs", "/sockjs-node/",
    "/favicon", "/manifest.json", "/robots.txt", "/sitemap",
    "/piwik.php", "/piwik.js", "/matomo.php", "/matomo.js",
  ];

  /** Standard browser headers that are NOT custom API auth. */
  private static readonly STANDARD_HEADERS = new Set([
    "x-requested-with", "x-forwarded-for", "x-forwarded-host",
    "x-forwarded-proto", "x-real-ip", "x-frame-options",
    "x-content-type-options", "x-xss-protection", "x-ua-compatible",
    "x-dns-prefetch-control", "x-download-options", "x-permitted-cross-domain-policies",
    "x-powered-by", "x-request-id", "x-correlation-id", "x-trace-id",
  ]);

  /** HTTP/2 pseudo-headers that must be filtered out before replay. */
  private static readonly HTTP2_PSEUDO_HEADERS = new Set([
    ":authority", ":method", ":path", ":scheme", ":status", ":protocol",
  ]);

  /** Context header names to capture (IDs, tenant info). */
  private static readonly CONTEXT_HEADER_NAMES = new Set([
    "outletid", "userid", "supplierid", "companyid",
  ]);

  isStaticAsset(url: string): boolean {
    const path = new URL(url).pathname.toLowerCase();
    if (TrafficFilter.STATIC_EXTS.some(ext => path.endsWith(ext))) return true;
    if (TrafficFilter.SKIP_PATHS.some(prefix => path.startsWith(prefix))) return true;
    return false;
  }

  isSkippedDomain(domain: string): boolean {
    return TrafficFilter.SKIP_DOMAINS.some(skip => domain.includes(skip));
  }

  isHtmlContentType(contentType: string): boolean {
    const ct = contentType.toLowerCase();
    return ct.includes("text/html") || ct.includes("application/xhtml");
  }

  isHttp2PseudoHeader(name: string): boolean {
    return name.startsWith(":") || TrafficFilter.HTTP2_PSEUDO_HEADERS.has(name.toLowerCase());
  }

  isStandardHeader(name: string): boolean {
    return TrafficFilter.STANDARD_HEADERS.has(name.toLowerCase());
  }

  isContextHeader(name: string): boolean {
    return TrafficFilter.CONTEXT_HEADER_NAMES.has(name.toLowerCase());
  }

  isApiLike(url: string, method: string, domain: string, contentType?: string): boolean {
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
      url.includes("/order") ||
      url.includes("/quote") ||
      url.includes("/swap") ||
      url.includes("/tokens") ||
      url.includes("/markets") ||
      url.includes("/user") ||
      url.includes("/auth") ||
      ["POST", "PUT", "DELETE", "PATCH"].includes(method) ||
      domain.includes("api.") ||
      domain.includes("service") ||
      domain.includes("quote") ||
      domain.startsWith("dev-")
    );
  }
}

// ---------------------------------------------------------------------------
// DomainDetector — extract service name, root domain, API domain detection
// ---------------------------------------------------------------------------

export class DomainDetector {
  /** Extract root domain from a hostname (e.g., "api.dflow.net" -> "dflow.net"). */
  getRootDomain(domain: string): string {
    const parts = domain.split(".");
    if (parts.length >= 2) return parts.slice(-2).join(".");
    return domain;
  }

  /** Check if two domains share the same root domain. */
  isSameRootDomain(domain1: string, domain2: string): boolean {
    return this.getRootDomain(domain1) === this.getRootDomain(domain2);
  }

  /** Derive a clean service name from a domain. */
  deriveServiceName(domain: string): string {
    let name = domain
      .replace(/^(www|api|v\d+|.*serv)\./, "")
      .replace(/\.(com|org|net|co|io|ai|app|sg|dev|xyz)\.?$/g, "")
      .replace(/\./g, "-")
      .toLowerCase();
    return name || "unknown-api";
  }

  /** Get the response content-type from a HAR entry. */
  getResponseContentType(entry: HarEntry): string | undefined {
    for (const header of entry.response?.headers ?? []) {
      if (header.name.toLowerCase() === "content-type") return header.value;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// HarParser — top-level orchestrator
// ---------------------------------------------------------------------------

/** Per-endpoint captured schema data from HAR entries. */
interface EndpointSchemaCapture {
  queryParams: Map<string, { name: string; type: string; example: string }>;
  requestBodySchemas: Record<string, string>[];
  responseBodySchemas: Record<string, string>[];
  responseBodyInferred?: InferredSchema;
  requestBodyInferred?: InferredSchema;
}

export class HarParser {
  readonly routeNormalizer = new RouteNormalizer();
  readonly fingerprinter = new EndpointFingerprinter(this.routeNormalizer);
  readonly schemaHasher = new SchemaHasher(this.fingerprinter);
  readonly trafficFilter = new TrafficFilter();
  readonly domainDetector = new DomainDetector();
  private readonly headerClassifier = new HeaderClassifier();
  /** Schema data captured per endpoint key (METHOD|normalizedPath) during parse(). */
  private schemaCaptureMap = new Map<string, EndpointSchemaCapture>();

  /**
   * Parse a HAR file or HAR JSON object into structured API data.
   *
   * @param seedUrl - The user-provided URL that initiated the capture. Used to
   *                  derive the service name and baseUrl instead of guessing from
   *                  the most-frequent request domain.
   */
  parse(har: { log: { entries: HarEntry[] } }, seedUrl?: string): ApiData {
    // Reset schema capture for fresh parse
    this.schemaCaptureMap = new Map();

    // Guard against null/undefined input
    if (!har || !har.log) {
      return {
        service: "unknown-api",
        baseUrls: [],
        baseUrl: "https://api.example.com",
        authHeaders: {},
        authMethod: "Unknown",
        cookies: {},
        authInfo: {},
        requests: [],
        endpoints: {},
      };
    }

    const requests: ParsedRequest[] = [];
    const authHeaders: Record<string, string> = {};
    const cookies: Record<string, string> = {};
    const authInfo: Record<string, string> = {};
    const baseUrls = new Set<string>();
    const targetDomains = new Set<string>();

    // If a seed URL is provided, extract its domain upfront
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
      const responseContentType = this.domainDetector.getResponseContentType(entry);

      // Skip static assets
      try {
        if (this.trafficFilter.isStaticAsset(url)) continue;
      } catch {
        continue;
      }

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }

      const domain = parsed.host;

      // Skip third-party
      if (this.trafficFilter.isSkippedDomain(domain)) continue;

      // Skip HTML page navigations
      if (method === "GET" && responseContentType && this.trafficFilter.isHtmlContentType(responseContentType)) {
        continue;
      }

      // Check if this domain is related to the seed domain
      const isSeedRelated = seedDomain && this.domainDetector.isSameRootDomain(domain, seedDomain);

      // Only keep API-like requests
      const isTargetDomain = targetDomains.has(domain) || isSeedRelated;
      if (!this.trafficFilter.isApiLike(url, method, domain, responseContentType) && targetDomains.size > 0 && !isTargetDomain) {
        continue;
      }

      targetDomains.add(domain);
      baseUrls.add(`${parsed.protocol}//${parsed.host}`);

      // Extract auth headers
      for (const header of entry.request.headers ?? []) {
        const name = header.name.toLowerCase();
        const value = header.value;

        if (this.trafficFilter.isHttp2PseudoHeader(name)) continue;

        if (this.headerClassifier.isAuthLike(name)) {
          authHeaders[name] = value;
          authInfo[`request_header_${name}`] = value;
        }

        if (this.trafficFilter.isContextHeader(name)) {
          authInfo[`request_header_${name}`] = value;
        }

        if (name.startsWith("x-") && !this.trafficFilter.isStandardHeader(name) && value) {
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

      // Normalize path
      const { normalizedPath, pathParams } = this.routeNormalizer.normalizePath(parsed.pathname);

      requests.push({
        method,
        url,
        path: parsed.pathname,
        domain,
        status: responseStatus,
        responseContentType,
        normalizedPath,
        pathParams: pathParams.length > 0 ? pathParams : undefined,
      });

      // ── Schema capture ──────────────────────────────────────────────
      const epKey = `${method}|${normalizedPath}`;
      if (!this.schemaCaptureMap.has(epKey)) {
        this.schemaCaptureMap.set(epKey, {
          queryParams: new Map(),
          requestBodySchemas: [],
          responseBodySchemas: [],
        });
      }
      const capture = this.schemaCaptureMap.get(epKey)!;

      // Query params
      for (const qp of entry.request.queryString ?? []) {
        if (!capture.queryParams.has(qp.name)) {
          capture.queryParams.set(qp.name, {
            name: qp.name,
            type: typeof qp.value === "number" ? "number" : "string",
            example: String(qp.value).slice(0, 50),
          });
        }
      }

      // Request body schema
      const reqBody = safeParseJson(entry.request.postData?.text);
      if (reqBody && typeof reqBody === "object") {
        const schema = getTopLevelSchema(reqBody);
        if (schema) capture.requestBodySchemas.push(schema);
        capture.requestBodyInferred = inferSchema(reqBody);
      }

      // Response body schema (only 2xx)
      if (responseStatus >= 200 && responseStatus < 300) {
        const respBody = safeParseJson(entry.response?.content?.text);
        if (respBody !== null) {
          const schema = getTopLevelSchema(respBody);
          if (schema) capture.responseBodySchemas.push(schema);
          capture.responseBodyInferred = inferSchema(respBody);
        }
      }
    }

    // Determine service name and base URL
    let service = "unknown-api";
    let baseUrl = "https://api.example.com";

    const findBestApiDomain = (): string | undefined => {
      const apiDomains = [...targetDomains].filter(d =>
        d.includes("api.") || d.includes("quote") || d.includes("service") || d.startsWith("dev-")
      );
      if (apiDomains.length > 0) {
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

    if (bestApiDomain && seedDomain && this.domainDetector.isSameRootDomain(bestApiDomain, seedDomain)) {
      service = this.domainDetector.deriveServiceName(seedDomain);
      baseUrl = `https://${bestApiDomain}`;
    } else if (seedDomain) {
      service = this.domainDetector.deriveServiceName(seedDomain);
      baseUrl = seedBaseUrl!;
    } else if (targetDomains.size > 0) {
      const domainCounts: Record<string, number> = {};
      for (const req of requests) {
        domainCounts[req.domain] = (domainCounts[req.domain] ?? 0) + 1;
      }
      const mainDomain = Object.entries(domainCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
      if (mainDomain) {
        service = this.domainDetector.deriveServiceName(mainDomain);
        baseUrl = `https://${mainDomain}`;
      }
    } else if (baseUrls.size > 0) {
      const first = [...baseUrls][0];
      const domain = new URL(first).host;
      service = this.domainDetector.deriveServiceName(domain);
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
      endpoints: this.groupByDomainAndPath(requests),
      headerProfile: buildHeaderProfiles(har.log.entries ?? [], targetDomains),
    };
  }

  /** Group requests by domain:path. */
  private groupByDomainAndPath(requests: ParsedRequest[]): Record<string, ParsedRequest[]> {
    const grouped: Record<string, ParsedRequest[]> = {};
    for (const req of requests) {
      const key = `${req.domain}:${req.path}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(req);
    }
    return grouped;
  }

  /**
   * Build EndpointGroup objects from parsed requests.
   * Applies cross-request generalization first, then groups by normalized
   * path + method, deduplicating by fingerprint.
   * Enriches with captured schemas, method names, and descriptions.
   */
  buildEndpointGroups(requests: ParsedRequest[]): EndpointGroup[] {
    // Apply cross-request generalization to detect varying segments
    crossRequestGeneralize(requests, this.routeNormalizer);

    const groups = new Map<string, EndpointGroup>();

    for (const req of requests) {
      const normalizedPath = req.normalizedPath ?? req.path;
      const key = `${req.method}|${normalizedPath}`;

      if (!groups.has(key)) {
        let category: "auth" | "read" | "write" | "delete" | "other" = "other";
        const m = req.method.toUpperCase();
        if (m === "GET" || m === "HEAD" || m === "OPTIONS") category = "read";
        else if (m === "DELETE") category = "delete";
        else if (m === "POST" || m === "PUT" || m === "PATCH") category = "write";
        if (/\b(auth|login|signin|token|oauth|session)\b/i.test(normalizedPath)) category = "auth";

        // Look up captured schema data
        const capture = this.schemaCaptureMap.get(key);
        const queryParams = capture ? [...capture.queryParams.values()] : [];

        // Merge request/response body schemas from all examples
        let requestBodySchema: InferredSchema | undefined;
        let responseBodySchema: InferredSchema | undefined;
        if (capture?.requestBodyInferred) {
          requestBodySchema = capture.requestBodyInferred;
        }
        if (capture?.responseBodyInferred) {
          responseBodySchema = capture.responseBodyInferred;
        }

        const methodName = generateMethodName(req.method, normalizedPath);
        const description = generateEndpointDescription(req.method, normalizedPath, queryParams);

        groups.set(key, {
          method: req.method,
          normalizedPath,
          description,
          category,
          pathParams: req.pathParams ?? [],
          queryParams,
          responseSummary: responseBodySchema?.summary ?? "",
          exampleCount: 1,
          dependencies: [],
          produces: [],
          consumes: [],
          methodName,
          requestBodySchema,
          responseBodySchema,
        });
      } else {
        groups.get(key)!.exampleCount++;
      }
    }

    return [...groups.values()];
  }
}

// ---------------------------------------------------------------------------
// enrichApiData — adds normalized paths and endpoint groups to ApiData
// ---------------------------------------------------------------------------

const _defaultParser = new HarParser();

/**
 * Enrich API data with normalized paths and endpoint groups.
 * Mutates the input and also returns it for convenience.
 *
 * Performs two passes:
 * 1. Single-request normalization (pattern-based: UUIDs, numerics, hex, etc.)
 * 2. Cross-request generalization: groups requests by method + segment count,
 *    detects positions where segments vary across requests, and re-normalizes
 *    those varying segments as path parameters.
 */
export function enrichApiData(apiData: ApiData): ApiData {
  const normalizer = _defaultParser.routeNormalizer;

  // ── Pass 1: Single-request normalization ─────────────────────────────
  for (const req of apiData.requests) {
    if (!req.normalizedPath) {
      const { normalizedPath, pathParams } = normalizer.normalizePath(req.path);
      req.normalizedPath = normalizedPath;
      if (pathParams.length > 0 && !req.pathParams) {
        req.pathParams = pathParams;
      }
    }
  }

  // Build endpoint groups (cross-request generalization happens inside)
  apiData.endpointGroups = _defaultParser.buildEndpointGroups(apiData.requests);

  return apiData;
}

/**
 * Cross-request generalization: detect varying segments across multiple
 * requests that share the same method and path structure.
 *
 * For each group of requests with the same method and segment count,
 * compare their normalized paths segment-by-segment. Positions where
 * segments vary (and aren't already parameterized) get re-normalized
 * as path parameters.
 */
function crossRequestGeneralize(
  requests: ParsedRequest[],
  normalizer: RouteNormalizer,
): void {
  // Group by method + number of segments in normalizedPath
  const groups = new Map<string, ParsedRequest[]>();
  for (const req of requests) {
    const np = req.normalizedPath ?? req.path;
    const segs = np.split("/").filter(s => s.length > 0);
    const key = `${req.method}|${segs.length}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(req);
  }

  for (const [, group] of groups) {
    if (group.length < 2) continue;

    // Split each request's normalized path into segments
    const segmentArrays = group.map(r => (r.normalizedPath ?? r.path).split("/").filter(s => s.length > 0));
    // Also keep original raw path segments for example values
    const rawSegmentArrays = group.map(r => r.path.split("/").filter(s => s.length > 0));
    const segCount = segmentArrays[0].length;

    // Find positions where segments vary across requests
    const varyingPositions: number[] = [];
    for (let pos = 0; pos < segCount; pos++) {
      const uniqueValues = new Set(segmentArrays.map(segs => segs[pos]));
      // Only consider positions that aren't already parameterized
      const allAlreadyParam = segmentArrays.every(segs => segs[pos]?.startsWith("{"));
      if (uniqueValues.size > 1 && !allAlreadyParam) {
        varyingPositions.push(pos);
      }
    }

    if (varyingPositions.length === 0) continue;

    // Guard: the group must share at least one non-varying literal segment
    // as an anchor. If every segment varies, these are unrelated paths.
    const hasSharedLiteral = segmentArrays[0].some((seg, i) =>
      !varyingPositions.includes(i) && !seg.startsWith("{")
    );
    if (!hasSharedLiteral) continue;

    // Build a template from the first request's segments
    // For non-varying positions, keep the existing value
    // For varying positions, parameterize
    const template = [...segmentArrays[0]];
    const templatePathParams: { name: string; type: string; example: string }[] = [];

    // Find the "static" segments (same across all requests) for context
    const staticSegments = template.map((seg, i) => varyingPositions.includes(i) ? null : seg);

    for (const pos of varyingPositions) {
      // Collect all unique values at this position (from raw paths)
      const examples = [...new Set(rawSegmentArrays.map(raw => raw[pos]).filter(Boolean))];
      const example = examples[0] ?? "";

      // Check if value has a file extension — strip it for the param, keep for template
      const extMatch = example.match(/(\.[a-z]{2,5})$/i);
      const ext = extMatch ? extMatch[1] : "";

      // Derive param name from the previous static segment
      const prevStatic = pos > 0 ? staticSegments[pos - 1] : null;
      let paramName: string;
      if (prevStatic && !prevStatic.startsWith("{")) {
        // Use the normalizer's naming convention by creating a fake normalization
        const fakeSegments = [prevStatic, example];
        const { pathParams: fakeParams } = normalizer.normalizePath(`/${fakeSegments.join("/")}`);
        paramName = fakeParams.length > 0 ? fakeParams[fakeParams.length - 1].name : "id";
      } else {
        paramName = "id";
      }

      template[pos] = `{${paramName}}` + ext;
      templatePathParams.push({ name: paramName, type: "string", example });
    }

    const newNormalizedPath = "/" + template.join("/");

    // Apply the generalized path to all requests in this group
    for (let i = 0; i < group.length; i++) {
      group[i].normalizedPath = newNormalizedPath;
      // Merge new path params with existing ones (avoid duplicates by name)
      const existing = group[i].pathParams ?? [];
      const existingNames = new Set(existing.map(p => p.name));
      const merged = [...existing];
      for (const pp of templatePathParams) {
        if (!existingNames.has(pp.name)) {
          // Use the actual raw value from this request as the example
          const rawSegs = rawSegmentArrays[i];
          const varyPos = varyingPositions[templatePathParams.indexOf(pp)];
          const realExample = rawSegs[varyPos] ?? pp.example;
          merged.push({ ...pp, example: realExample });
        }
      }
      group[i].pathParams = merged.length > 0 ? merged : undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible function exports
// ---------------------------------------------------------------------------

/**
 * Parse a HAR file or HAR JSON object into structured API data.
 *
 * @param seedUrl - The user-provided URL that initiated the capture. Used to
 *                  derive the service name and baseUrl instead of guessing from
 *                  the most-frequent request domain.
 */
export function parseHar(har: { log: { entries: HarEntry[] } }, seedUrl?: string): ApiData {
  return _defaultParser.parse(har, seedUrl);
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

  const normalizer = _defaultParser.routeNormalizer;

  for (const ep of openApiEndpoints) {
    const key = `${ep.method}:${ep.path}`;
    if (existingKeys.has(key)) continue;

    const groupKey = `${domain}:${ep.path}`;
    const { normalizedPath, pathParams } = normalizer.normalizePath(ep.path);

    const syntheticRequest: ParsedRequest = {
      method: ep.method,
      url: `${baseUrl.replace(/\/$/, "")}${ep.path}`,
      path: ep.path,
      domain,
      status: 0,
      fromSpec: true,
      normalizedPath,
      pathParams: pathParams.length > 0 ? pathParams : undefined,
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
