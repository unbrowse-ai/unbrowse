import type { RawRequest } from "../capture/index.js";
import type { EndpointDescriptor } from "../types/index.js";
import { nanoid } from "nanoid";

const SKIP_EXTENSIONS = /\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|map|webp|html)$/i;
const SKIP_JS_BUNDLES = /\/(boq-|_\/mss\/|og\/_\/js\/|_\/scs\/)/i;
const SKIP_HOSTS = /(cloudflare\.com|google-analytics\.com|doubleclick\.net|gstatic\.com|accounts\.google\.com|login\.microsoftonline\.com|auth0\.com|cognito-idp\.|appleid\.apple\.com|github\.com\/login|facebook\.com\/login)/i;
const RPC_HINTS = /(\/$rpc\/|\/rpc\/|graphql|\/api\/|\/v\d+\/|trending|search|data|query|feed|results)/i;

// Score a request: higher = more likely to be a real data API
function scoreRequest(req: RawRequest): number {
  let score = 0;
  if (req.method !== "GET") score += 3;
  if (RPC_HINTS.test(req.url)) score += 3;
  if (SKIP_JS_BUNDLES.test(req.url)) score -= 10;
  if (req.response_headers?.["content-type"]?.includes("application/json")) score += 4;
  if (req.response_headers?.["content-type"]?.includes("application/x-protobuf")) score += 3;
  if (req.url.length > 500) score -= 5; // penalise JS bundle query strings
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

    const isGet = req.method === "GET";

    endpoints.push({
      endpoint_id: nanoid(),
      method: req.method as EndpointDescriptor["method"],
      url_template: normalized,
      headers_template: sanitizeHeaders(req.request_headers),
      query: isGet ? extractQueryParams(req.url) : undefined,
      body: !isGet && req.request_body ? tryParseBody(req.request_body) : undefined,
      idempotency: isGet ? "safe" : "unsafe",
      verification_status: "unverified",
      reliability_score: 0,
    });
  }

  return endpoints;
}

function isApiLike(req: RawRequest): boolean {
  if (SKIP_EXTENSIONS.test(req.url)) return false;
  if (SKIP_JS_BUNDLES.test(req.url)) return false;
  try {
    const host = new URL(req.url).hostname;
    if (SKIP_HOSTS.test(host)) return false;
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
  const STRIP = new Set(["cookie", "authorization", "x-csrf-token", "content-length", "host"]);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([k]) => !STRIP.has(k.toLowerCase()))
  );
}

function tryParseBody(body: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
