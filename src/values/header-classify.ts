/**
 * header-classify — client-safe header sanitisation: which captured headers are
 * sensitive (strip), which are replay-critical (keep for the vault), and the GraphQL
 * operation name. These are pure classifiers over header names/values with NO
 * reverse-engineering-engine dependency, so the client can decide what to redact and
 * what to keep when it obfuscates a capture WITHOUT importing src/reverse-engineer
 * (the endpoint-extraction moat). The engine re-imports them for its own sanitisation.
 */
import type { RawRequest } from "../capture/index.js";

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

// Browser-captured headers that are not secrets themselves, but are still
// required to replay authenticated requests after publish-time header redaction.
const REPLAY_HEADER_PREFIXES = [
  "x-li-",
];
const REPLAY_HEADER_EXACT = new Set([
  "accept",
  "csrf-token",
  "origin",
  "x-requested-with",
  "x-restli-protocol-version",
]);

// Headers known to be safe (non-sensitive) — used by the catch-all filter below
const SAFE_HEADERS = new Set([
  "accept", "accept-encoding", "accept-language", "cache-control",
  "content-type", "origin", "referer", "user-agent", "pragma",
  "if-none-match", "if-modified-since", "range", "dnt", "connection",
  "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
  "sec-ch-ua-full-version-list", "sec-ch-ua-arch", "sec-ch-ua-bitness",
  "sec-ch-ua-model", "sec-ch-ua-wow64",
  "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
  "upgrade-insecure-requests",
  "x-requested-with",
]);

// Patterns that indicate a header contains credentials — catch-all safety net
const SENSITIVE_HEADER_PATTERN = /token|key|secret|credential|password|session/i;

/**
 * Extract GraphQL operation name from a request body or URL. Handles X.com URL
 * pattern, standard operationName, inline query, Facebook fb_api_req_friendly_name /
 * doc_id, and Instagram query_hash.
 */
export function extractGraphQLOperationName(url: string, requestBody?: string): string | undefined {
  // Try URL path first (X.com style: /graphql/{hash}/OperationName)
  const urlMatch = url.match(/\/graphql\/[^/]+\/(\w+)/);
  if (urlMatch) return urlMatch[1];

  if (!requestBody) return undefined;

  // Handle form-encoded bodies (Facebook sometimes sends as application/x-www-form-urlencoded)
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    // Try URL-encoded form data (fb_api_req_friendly_name=FooQuery&doc_id=123&...)
    if (requestBody.includes("=") && !requestBody.includes("{")) {
      try {
        const params = new URLSearchParams(requestBody);
        const friendly = params.get("fb_api_req_friendly_name");
        if (friendly) return friendly;
        const docId = params.get("doc_id");
        if (docId) return `doc_${docId}`;
        const queryHash = params.get("query_hash");
        if (queryHash) return `qh_${queryHash}`;
      } catch { /* not form data */ }
    }
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") return undefined;

  // Standard GraphQL operationName
  if (typeof parsed.operationName === "string" && parsed.operationName) {
    return parsed.operationName;
  }

  // Extract from inline query string
  const queryStr = typeof parsed.query === "string" ? parsed.query : undefined;
  if (queryStr) {
    const match = queryStr.match(/(?:query|mutation|subscription)\s+(\w+)/);
    if (match) return match[1];
  }

  // Facebook: fb_api_req_friendly_name
  if (typeof parsed.fb_api_req_friendly_name === "string" && parsed.fb_api_req_friendly_name) {
    return parsed.fb_api_req_friendly_name;
  }

  // Facebook: doc_id (numeric identifier for persisted queries)
  if (typeof parsed.doc_id === "string" && parsed.doc_id) {
    return `doc_${parsed.doc_id}`;
  }
  if (typeof parsed.doc_id === "number") {
    return `doc_${parsed.doc_id}`;
  }

  // Instagram: query_hash
  if (typeof parsed.query_hash === "string" && parsed.query_hash) {
    return `qh_${parsed.query_hash}`;
  }

  return undefined;
}

/** Returns true if a header name is sensitive and should be stripped from skill manifests. */
export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "cookie" || lower === "content-length" || lower === "host") return false; // handled separately
  if (STRIP_HEADERS.has(lower)) return true;
  if (STRIP_HEADER_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (lower.startsWith("x-goog-api")) return true;
  if (lower.startsWith("x-server-")) return true;
  if (!SAFE_HEADERS.has(lower) && SENSITIVE_HEADER_PATTERN.test(lower)) return true;
  return false;
}

export function isReplayCriticalHeader(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (REPLAY_HEADER_EXACT.has(lower)) {
    if (lower !== "accept") return true;
    return /application\/vnd\./i.test(value);
  }
  return REPLAY_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
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
      if ((isSensitiveHeader(k) || isReplayCriticalHeader(k, v)) && !authHeaders[lower]) {
        authHeaders[lower] = v;
      }
    }
  }
  return authHeaders;
}
