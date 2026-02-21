import type { RawRequest } from "../capture/index.js";
import type { EndpointDescriptor } from "../types/index.js";
import { inferSchema } from "../transform/index.js";
import { nanoid } from "nanoid";

const SKIP_EXTENSIONS = /\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map|webp|html)$/i;
const SKIP_JS_BUNDLES = /\/(boq-|_\/mss\/|og\/_\/js\/|_\/scs\/)/i;

// Known infrastructure/auth hosts — never useful as skill endpoints
const SKIP_HOSTS = /(cloudflare\.com|google-analytics\.com|doubleclick\.net|gstatic\.com|accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|appleid\.apple\.com|github\.com\/login|facebook\.com\/login|protechts\.net|demdex\.net|litms|platform-telemetry)/i;

// Google-specific telemetry, ads, and infrastructure subdomains (BUG-GC-004)
const SKIP_TELEMETRY_HOSTS = /(waa-pa\.|signaler-pa\.|appsgrowthpromo-pa\.|ogads-pa\.|peoplestackwebexperiments-pa\.)/i;

// Known telemetry/logging path patterns
const SKIP_TELEMETRY_PATHS = /\/(log|logging|telemetry|analytics|beacon|ping|heartbeat|metrics)(\/|$)/i;

// RPC/API path hints — tightened to avoid false positives (BUG-GC-004)
const RPC_HINTS = /(\/$rpc\/|\/rpc\/|graphql|trending|search|feed|results)/i;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Headers that must never be stored in skill manifests (BUG-GC-005)
// Includes session tokens, API keys, and Google-specific credential headers.
const STRIP_HEADERS = new Set([
  "cookie",
  "authorization",
  "x-csrf-token",
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
const STRIP_HEADER_PREFIXES = ["x-goog-auth", "x-goog-spatula"];

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
  return score;
}

export function extractEndpoints(requests: RawRequest[]): EndpointDescriptor[] {
  const seen = new Set<string>();
  const endpoints: EndpointDescriptor[] = [];

  const scored = requests
    .map((r) => ({ req: r, score: scoreRequest(r) }))
    .filter(({ req, score }) => isApiLike(req) && score > 0)
    .sort((a, b) => b.score - a.score);

  for (const { req } of scored) {
    const normalized = normalizeUrl(req.url);
    const key = `${req.method}:${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);

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
        const parsed = JSON.parse(req.response_body);
        response_schema = inferSchema([parsed]);
      } catch {
        // not valid JSON — skip schema inference
      }
    }

    // BUG-008: mark endpoints with no response body as potentially CF-blocked
    const verificationStatus = req.response_body ? "unverified" as const : "pending" as const;

    endpoints.push({
      endpoint_id: nanoid(),
      method: req.method as EndpointDescriptor["method"],
      url_template: normalized,
      headers_template: sanitizeHeaders(req.request_headers),
      query: isGet ? extractQueryParams(req.url) : undefined,
      body: !isGet && req.request_body ? tryParseBody(req.request_body) : undefined,
      idempotency: isGet ? "safe" : "unsafe",
      verification_status: verificationStatus,
      reliability_score: 0.5,
      response_schema,
    });
  }

  return endpoints;
}

function isApiLike(req: RawRequest): boolean {
  if (!ALLOWED_METHODS.has(req.method.toUpperCase())) return false;
  if (SKIP_EXTENSIONS.test(req.url)) return false;
  if (SKIP_JS_BUNDLES.test(req.url)) return false;
  try {
    const { hostname, pathname } = new URL(req.url);
    if (SKIP_HOSTS.test(hostname)) return false;
    if (SKIP_TELEMETRY_HOSTS.test(hostname)) return false;  // BUG-GC-004
    if (SKIP_TELEMETRY_PATHS.test(pathname)) return false;  // BUG-GC-004
    // play.google.com/log is telemetry, not calendar data
    if (hostname === "play.google.com" && pathname.startsWith("/log")) return false;
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
      .replace(/\/[a-f0-9]{24,}/gi, "/{id}");
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

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([k]) => {
      const lower = k.toLowerCase();
      if (STRIP_HEADERS.has(lower)) return false;
      // Strip all x-goog-auth* and x-goog-spatula* prefixes (BUG-GC-005)
      if (STRIP_HEADER_PREFIXES.some((p) => lower.startsWith(p))) return false;
      // Strip all x-goog-api-* variants (catches x-goog-api-key and siblings)
      if (lower.startsWith("x-goog-api")) return false;
      // Strip server-side token headers
      if (lower.startsWith("x-server-")) return false;
      return true;
    })
  );
}

function isJsonParseable(body?: string): boolean {
  if (!body) return false;
  try { JSON.parse(body); return true; } catch { return false; }
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
