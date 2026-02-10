/**
 * Auth Extractor — Determine authentication method and build auth.json.
 *
 * Ported from meta_learner_simple.py guess_auth_method() + generate_auth_json().
 */

import type { ApiData, AuthInfo } from "./types.js";

// ── Header classification ────────────────────────────────────────────────

const AUTH_HEADER_NAMES = new Set([
  "authorization", "x-api-key", "api-key", "apikey",
  "x-auth-token", "access-token", "x-access-token",
  "token", "x-token", "authtype", "mudra",
  "bearer", "jwt", "x-jwt", "x-jwt-token", "id-token", "id_token",
  "x-id-token", "refresh-token", "x-refresh-token",
  "x-apikey", "x-key", "key", "secret", "x-secret",
  "api-secret", "x-api-secret", "client-secret", "x-client-secret",
  "session", "session-id", "sessionid", "x-session", "x-session-id",
  "x-session-token", "session-token", "csrf", "x-csrf", "x-csrf-token",
  "csrf-token", "x-xsrf-token", "xsrf-token",
  "x-oauth-token", "oauth-token", "x-oauth", "oauth",
  "x-amz-security-token", "x-amz-access-token",
  "x-goog-api-key",
  "x-rapidapi-key",
  "ocp-apim-subscription-key",
  "x-functions-key",
  "x-auth", "x-authentication", "x-authorization",
  "x-user-token", "x-app-token", "x-client-token",
  "x-access-key", "x-secret-key", "x-signature",
  "x-request-signature", "signature",
]);

const AUTH_HEADER_PATTERNS = [
  "auth", "token", "key", "secret", "bearer", "jwt",
  "session", "credential", "password", "signature", "sign",
  "api-", "apikey", "access", "oauth", "csrf", "xsrf",
];

/** Classifies HTTP headers as auth-related or standard. */
export class HeaderClassifier {
  isAuthLike(name: string): boolean {
    const lower = name.toLowerCase();
    if (AUTH_HEADER_NAMES.has(lower)) return true;
    return AUTH_HEADER_PATTERNS.some(p => lower.includes(p));
  }
}

/**
 * Determine the auth method from extracted headers and cookies.
 * Analyzes all captured auth-related headers to identify the primary auth mechanism.
 */
export function guessAuthMethod(
  authHeaders: Record<string, string>,
  cookies: Record<string, string>,
): string {
  const headerNames = Object.keys(authHeaders).map(h => h.toLowerCase());
  const headerValues = Object.values(authHeaders);

  // Check for Bearer token (most common)
  for (const value of headerValues) {
    if (value.toLowerCase().startsWith("bearer ")) return "Bearer Token";
  }

  // Check for specific auth header patterns (in priority order)

  // API Key variants
  const apiKeyHeaders = headerNames.filter(h =>
    h.includes("api-key") || h.includes("apikey") || h === "x-api-key" || h === "x-key"
  );
  if (apiKeyHeaders.length > 0) {
    return `API Key (${apiKeyHeaders[0]})`;
  }

  // JWT variants
  const jwtHeaders = headerNames.filter(h =>
    h.includes("jwt") || h.includes("id-token") || h.includes("id_token")
  );
  if (jwtHeaders.length > 0) {
    return `JWT (${jwtHeaders[0]})`;
  }

  // Standard Authorization header (but not Bearer)
  if (headerNames.includes("authorization")) {
    const authValue = authHeaders["authorization"] || authHeaders["Authorization"];
    if (authValue?.toLowerCase().startsWith("basic ")) return "Basic Auth";
    if (authValue?.toLowerCase().startsWith("digest ")) return "Digest Auth";
    return "Authorization Header";
  }

  // Session/CSRF tokens
  const sessionHeaders = headerNames.filter(h =>
    h.includes("session") || h.includes("csrf") || h.includes("xsrf")
  );
  if (sessionHeaders.length > 0) {
    return `Session Token (${sessionHeaders[0]})`;
  }

  // AWS specific
  if (headerNames.some(h => h.includes("amz"))) return "AWS Signature";

  // Mudra token (Zeemart-specific)
  if ("mudra" in authHeaders) return "Mudra Token";

  // OAuth tokens
  const oauthHeaders = headerNames.filter(h => h.includes("oauth"));
  if (oauthHeaders.length > 0) return `OAuth (${oauthHeaders[0]})`;

  // Generic auth/token headers
  const authTokenHeaders = headerNames.filter(h =>
    h.includes("auth") || h.includes("token")
  );
  if (authTokenHeaders.length > 0) {
    return `Custom Token (${authTokenHeaders[0]})`;
  }

  // Any x-* custom header that was captured (likely auth-related)
  const customHeaders = headerNames.filter(h => h.startsWith("x-"));
  if (customHeaders.length > 0) {
    return `Custom Header (${customHeaders[0]})`;
  }

  // Cookie-based auth (fallback)
  const authCookieNames = [
    "session", "sessionid", "token", "authtoken", "jwt", "auth",
    "access_token", "accesstoken", "id_token", "refresh_token"
  ];
  for (const name of authCookieNames) {
    if (Object.keys(cookies).some((c) => c.toLowerCase() === name.toLowerCase())) {
      return `Cookie-based (${name})`;
    }
  }

  // Any cookie that looks auth-related
  const authCookies = Object.keys(cookies).filter(c =>
    c.toLowerCase().includes("auth") ||
    c.toLowerCase().includes("token") ||
    c.toLowerCase().includes("session")
  );
  if (authCookies.length > 0) {
    return `Cookie-based (${authCookies[0]})`;
  }

  return "Unknown (may need login)";
}

/**
 * Generate auth.json data from parsed API data.
 * Captures all discovered auth headers, cookies, and metadata.
 */
export function generateAuthInfo(service: string, data: ApiData): AuthInfo {
  const auth: AuthInfo = {
    service,
    baseUrl: data.baseUrl,
    authMethod: data.authMethod,
    timestamp: new Date().toISOString(),
    notes: [],
  };

  // Categorize headers by type for clarity
  const apiKeyHeaders: Record<string, string> = {};
  const authTokenHeaders: Record<string, string> = {};
  const sessionHeaders: Record<string, string> = {};
  const customHeaders: Record<string, string> = {};

  for (const [name, value] of Object.entries(data.authHeaders)) {
    const lower = name.toLowerCase();
    if (lower.includes("api-key") || lower.includes("apikey") || lower === "x-key") {
      apiKeyHeaders[name] = value;
    } else if (lower.includes("token") || lower.includes("jwt") || lower === "authorization") {
      authTokenHeaders[name] = value;
    } else if (lower.includes("session") || lower.includes("csrf")) {
      sessionHeaders[name] = value;
    } else {
      customHeaders[name] = value;
    }
  }

  // Store all headers
  if (Object.keys(data.authHeaders).length > 0) {
    auth.headers = { ...data.authHeaders };

    // Add detailed notes about what was found
    const notes: string[] = [];
    if (Object.keys(apiKeyHeaders).length > 0) {
      notes.push(`API keys: ${Object.keys(apiKeyHeaders).join(", ")}`);
    }
    if (Object.keys(authTokenHeaders).length > 0) {
      notes.push(`Auth tokens: ${Object.keys(authTokenHeaders).join(", ")}`);
    }
    if (Object.keys(sessionHeaders).length > 0) {
      notes.push(`Session headers: ${Object.keys(sessionHeaders).join(", ")}`);
    }
    if (Object.keys(customHeaders).length > 0) {
      notes.push(`Custom headers: ${Object.keys(customHeaders).join(", ")}`);
    }
    auth.notes.push(`Found ${Object.keys(data.authHeaders).length} auth header(s): ${notes.join("; ")}`);
  }

  // Mudra token special handling
  if (data.authHeaders.mudra) {
    auth.mudraToken = data.authHeaders.mudra;
    auth.notes.push("mudra token extracted (session token)");
    if (data.authHeaders.mudra.includes("--")) {
      auth.userId = data.authHeaders.mudra.split("--")[0];
    }
  }

  // Outlet IDs
  const outletHeader = data.authInfo.request_header_outletid;
  if (outletHeader) {
    if (!auth.headers) auth.headers = {};
    auth.headers.outletid = outletHeader;
    auth.outletIds = outletHeader.split(",");
    auth.notes.push(`Found ${auth.outletIds.length} outlet ID(s)`);
  }

  // Cookies - categorize auth-related vs general
  if (Object.keys(data.cookies).length > 0) {
    auth.cookies = { ...data.cookies };

    const authCookies = Object.keys(data.cookies).filter(c => {
      const lower = c.toLowerCase();
      return lower.includes("auth") || lower.includes("token") ||
             lower.includes("session") || lower.includes("jwt") ||
             lower.includes("access") || lower.includes("id_token");
    });

    if (authCookies.length > 0) {
      auth.notes.push(`Found ${authCookies.length} auth cookie(s): ${authCookies.join(", ")}`);
    }
    auth.notes.push(`Found ${Object.keys(data.cookies).length} total cookie(s)`);
  }

  // Full auth info - capture all custom x-* headers and auth-related data
  // Expand limit from 20 to 50 to capture more potential auth data
  if (Object.keys(data.authInfo).length > 0) {
    auth.authInfo = Object.fromEntries(Object.entries(data.authInfo).slice(0, 50));
  }

  return auth;
}
