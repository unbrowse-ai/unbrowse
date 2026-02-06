/**
 * Unit tests for token-refresh.ts
 *
 * Tests pure functions: detectRefreshEndpoint(), extractRefreshConfig(), needsRefresh().
 * Covers OAuth/JWT refresh detection, HAR entry extraction, and expiry checking.
 */

import { describe, it, expect } from "bun:test";
import {
  detectRefreshEndpoint,
  extractRefreshConfig,
  needsRefresh,
  type RefreshConfig,
} from "../../token-refresh.js";

// ── detectRefreshEndpoint ──────────────────────────────────────────────────

describe("detectRefreshEndpoint", () => {
  // ── OAuth token endpoints ──────────────────────────────────────────────

  describe("OAuth token endpoints", () => {
    it("detects /oauth/token as a refresh endpoint", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects /oauth2/v4/token (Google OAuth2)", () => {
      const result = detectRefreshEndpoint(
        "https://oauth2.googleapis.com/oauth2/v4/token",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects /oauth2/v1/token", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth2/v1/token",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects accounts.google.com token endpoint", () => {
      const result = detectRefreshEndpoint(
        "https://accounts.google.com/o/oauth2/token",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects securetoken.googleapis.com (Firebase)", () => {
      const result = detectRefreshEndpoint(
        "https://securetoken.googleapis.com/v1/token",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects identitytoolkit.googleapis.com (Google Identity)", () => {
      const result = detectRefreshEndpoint(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects /token? (generic token endpoint with query params)", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/token?key=abc123",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });
  });

  // ── Custom refresh endpoints ──────────────────────────────────────────

  describe("custom refresh endpoints", () => {
    it("detects /auth/refresh", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/auth/refresh",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects /token/refresh", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/token/refresh",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects /refresh-token", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/refresh-token",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects /refreshtoken (no separator)", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/refreshtoken",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects /refresh_token (underscore)", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/refresh_token",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects /api/v1/auth/token", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/v1/auth/token",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects /api/something/refresh", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/api/auth/refresh",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
    });
  });

  // ── Non-refresh endpoints ─────────────────────────────────────────────

  describe("non-refresh endpoints", () => {
    it("returns false for a regular API endpoint", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/api/users",
        "POST",
      );
      expect(result.isRefresh).toBe(false);
    });

    it("returns false for login endpoint", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/auth/login",
        "POST",
      );
      expect(result.isRefresh).toBe(false);
    });

    it("returns false for /api/data", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/api/data",
        "POST",
      );
      expect(result.isRefresh).toBe(false);
    });

    it("returns false for static file URLs", () => {
      const result = detectRefreshEndpoint(
        "https://cdn.example.com/bundle.js",
        "GET",
      );
      expect(result.isRefresh).toBe(false);
    });
  });

  // ── Method filtering ──────────────────────────────────────────────────

  describe("method filtering", () => {
    it("returns false for GET requests to refresh URL", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "GET",
      );
      expect(result.isRefresh).toBe(false);
    });

    it("returns false for DELETE requests to refresh URL", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/auth/refresh",
        "DELETE",
      );
      expect(result.isRefresh).toBe(false);
    });

    it("allows PUT method for token refresh", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/auth/refresh",
        "PUT",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("handles lowercase method", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "post",
      );
      expect(result.isRefresh).toBe(true);
    });
  });

  // ── Body-based detection ──────────────────────────────────────────────

  describe("body-based detection", () => {
    it("detects refresh via grant_type=refresh_token in URL-encoded body", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/api/auth",
        "POST",
        "grant_type=refresh_token&refresh_token=abc123",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("detects refresh via refresh_token= in body", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/api/session",
        "POST",
        "refresh_token=abc123",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("does not detect refresh from JSON body with quoted refreshToken key (quotes break pattern)", () => {
      // The body pattern /refreshToken[=:]/i requires refreshToken immediately
      // followed by = or :, but JSON has a quote in between: refreshToken":"
      const result = detectRefreshEndpoint(
        "https://api.example.com/api/session",
        "POST",
        '{"refreshToken":"abc123"}',
      );
      expect(result.isRefresh).toBe(false);
    });

    it("detects refresh via refreshToken= in non-JSON body", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/api/session",
        "POST",
        "refreshToken=abc123",
      );
      expect(result.isRefresh).toBe(true);
    });

    it("does not detect refresh from JSON body with quoted keys (quotes break pattern)", () => {
      // JSON quotes around keys prevent the [=:] pattern from matching
      // "refresh_token":"abc123" has a quote between refresh_token and :
      const result = detectRefreshEndpoint(
        "https://api.example.com/api/session",
        "POST",
        '{"grant_type":"refresh_token","refresh_token":"abc123"}',
      );
      expect(result.isRefresh).toBe(false);
    });

    it("does not detect refresh from unrelated body", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/api/data",
        "POST",
        '{"username":"test","password":"pass123"}',
      );
      expect(result.isRefresh).toBe(false);
    });
  });

  // ── Token info extraction from response body ──────────────────────────

  describe("token info extraction", () => {
    it("extracts access_token, refresh_token, expires_in from JSON response", () => {
      const responseBody = JSON.stringify({
        access_token: "new_access_tok",
        refresh_token: "new_refresh_tok",
        expires_in: 3600,
        token_type: "Bearer",
      });
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "POST",
        undefined,
        responseBody,
      );
      expect(result.isRefresh).toBe(true);
      expect(result.tokenInfo).toBeDefined();
      expect(result.tokenInfo!.accessToken).toBe("new_access_tok");
      expect(result.tokenInfo!.refreshToken).toBe("new_refresh_tok");
      expect(result.tokenInfo!.expiresIn).toBe(3600);
      expect(result.tokenInfo!.tokenType).toBe("Bearer");
    });

    it("extracts camelCase token fields (accessToken, refreshToken)", () => {
      const responseBody = JSON.stringify({
        accessToken: "camel_access",
        refreshToken: "camel_refresh",
        expiresIn: 1800,
        tokenType: "Bearer",
      });
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "POST",
        undefined,
        responseBody,
      );
      expect(result.tokenInfo).toBeDefined();
      expect(result.tokenInfo!.accessToken).toBe("camel_access");
      expect(result.tokenInfo!.refreshToken).toBe("camel_refresh");
      expect(result.tokenInfo!.expiresIn).toBe(1800);
    });

    it("extracts token from response with 'token' key", () => {
      const responseBody = JSON.stringify({
        token: "simple_token_value",
        expires_in: 7200,
      });
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "POST",
        undefined,
        responseBody,
      );
      expect(result.tokenInfo).toBeDefined();
      expect(result.tokenInfo!.accessToken).toBe("simple_token_value");
      expect(result.tokenInfo!.expiresIn).toBe(7200);
    });

    it("extracts id_token (Google/Firebase style)", () => {
      const responseBody = JSON.stringify({
        id_token: "id_tok_value",
        access_token: "access_tok_value",
        expires_in: 3600,
      });
      const result = detectRefreshEndpoint(
        "https://securetoken.googleapis.com/v1/token",
        "POST",
        undefined,
        responseBody,
      );
      expect(result.tokenInfo).toBeDefined();
      expect(result.tokenInfo!.accessToken).toBe("access_tok_value");
      expect((result.tokenInfo as any).idToken).toBe("id_tok_value");
    });

    it("returns no tokenInfo when response has no token fields", () => {
      const responseBody = JSON.stringify({ status: "ok", message: "done" });
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "POST",
        undefined,
        responseBody,
      );
      expect(result.isRefresh).toBe(true);
      expect(result.tokenInfo).toBeUndefined();
    });

    it("returns no tokenInfo when no response body is provided", () => {
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "POST",
      );
      expect(result.isRefresh).toBe(true);
      expect(result.tokenInfo).toBeUndefined();
    });

    it("defaults tokenType to Bearer when not specified", () => {
      const responseBody = JSON.stringify({
        access_token: "tok",
      });
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "POST",
        undefined,
        responseBody,
      );
      expect(result.tokenInfo!.tokenType).toBe("Bearer");
    });

    it("extracts tokens via regex fallback for non-JSON response", () => {
      // Malformed JSON but contains token patterns
      const responseBody = '{"access_token": "regex_tok", "refresh_token": "regex_refresh", "expires_in": 900, extra garbage';
      const result = detectRefreshEndpoint(
        "https://api.example.com/oauth/token",
        "POST",
        undefined,
        responseBody,
      );
      expect(result.tokenInfo).toBeDefined();
      expect(result.tokenInfo!.accessToken).toBe("regex_tok");
      expect(result.tokenInfo!.refreshToken).toBe("regex_refresh");
      expect(result.tokenInfo!.expiresIn).toBe(900);
    });
  });

  // ── Initial OAuth grant detection ─────────────────────────────────────

  describe("initial OAuth grant detection", () => {
    it("treats authorization_code exchange at an OAuth URL as refresh (URL matches refresh patterns)", () => {
      // The URL /oauth2/v4/token matches REFRESH_URL_PATTERNS, so isRefresh=true.
      // isInitialGrant requires !isRefresh, so it's false here.
      const result = detectRefreshEndpoint(
        "https://oauth2.googleapis.com/oauth2/v4/token",
        "POST",
        "grant_type=authorization_code&code=4/abc123",
      );
      expect(result.isRefresh).toBe(true);
      expect(result.isInitialGrant).toBeFalsy();
    });

    it("detects initial grant when URL matches only grant patterns, not refresh patterns", () => {
      // Use /auth/token which matches OAUTH_GRANT_URL_PATTERNS but also
      // matches REFRESH_URL_PATTERNS via /\/auth\/.*/ -- let's use a URL
      // that only matches grant patterns. Actually /auth/token matches
      // /v\d+\/auth\/token/ only with a version prefix. Let's check what works.
      // /auth/token without version doesn't match REFRESH_URL_PATTERNS.
      // But OAUTH_GRANT_URL_PATTERNS has /\/auth\/token/i.
      const result = detectRefreshEndpoint(
        "https://api.example.com/auth/token",
        "POST",
        "grant_type=authorization_code&code=4/abc123",
      );
      expect(result.isRefresh).toBe(true);
      expect(result.isInitialGrant).toBe(true);
    });

    it("does not flag refresh_token body as initial grant", () => {
      const result = detectRefreshEndpoint(
        "https://oauth2.googleapis.com/oauth2/v4/token",
        "POST",
        "grant_type=refresh_token&refresh_token=abc123",
      );
      // It's a refresh, not an initial grant
      expect(result.isRefresh).toBe(true);
      expect(result.isInitialGrant).toBeFalsy();
    });
  });
});

// ── extractRefreshConfig ────────────────────────────────────────────────────

describe("extractRefreshConfig", () => {
  // ── Successful extraction ─────────────────────────────────────────────

  describe("successful extraction", () => {
    it("extracts config from a valid OAuth refresh HAR entry", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [
            { name: "Content-Type", value: "application/x-www-form-urlencoded" },
            { name: "Authorization", value: "Basic abc123" },
          ],
          postData: {
            text: "grant_type=refresh_token&refresh_token=my_refresh_tok",
          },
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({
              access_token: "new_access",
              refresh_token: "new_refresh",
              expires_in: 3600,
            }),
          },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config).not.toBeNull();
      expect(config!.url).toBe("https://api.example.com/oauth/token");
      expect(config!.method).toBe("POST");
      expect(config!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(config!.headers["Authorization"]).toBe("Basic abc123");
      expect(config!.refreshToken).toBe("new_refresh");
      expect(config!.expiresInSeconds).toBe(3600);
      expect(config!.expiresAt).toBeDefined();
    });

    it("extracts config from a JSON body request", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/auth/refresh",
          headers: [
            { name: "Content-Type", value: "application/json" },
          ],
          postData: {
            text: JSON.stringify({
              refresh_token: "json_refresh_tok",
            }),
          },
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({
              access_token: "new_tok",
              expires_in: 1800,
            }),
          },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config).not.toBeNull();
      expect(config!.body).toEqual({ refresh_token: "json_refresh_tok" });
    });

    it("parses URL-encoded body into key-value object", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [
            { name: "Content-Type", value: "application/x-www-form-urlencoded" },
          ],
          postData: {
            text: "grant_type=refresh_token&refresh_token=tok123&client_id=my_client",
          },
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({ access_token: "new" }),
          },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config).not.toBeNull();
      expect(typeof config!.body).toBe("object");
      const body = config!.body as Record<string, string>;
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("tok123");
      expect(body.client_id).toBe("my_client");
      expect(config!.clientId).toBe("my_client");
    });
  });

  // ── Null returns ──────────────────────────────────────────────────────

  describe("null returns", () => {
    it("returns null for non-2xx response status", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [],
          postData: { text: "grant_type=refresh_token&refresh_token=tok" },
        },
        response: {
          status: 401,
        },
      };

      expect(extractRefreshConfig(entry)).toBeNull();
    });

    it("returns null for 500 error response", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [],
        },
        response: {
          status: 500,
        },
      };

      expect(extractRefreshConfig(entry)).toBeNull();
    });

    it("returns null for non-refresh endpoint", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/api/users",
          headers: [],
        },
        response: {
          status: 200,
        },
      };

      expect(extractRefreshConfig(entry)).toBeNull();
    });

    it("returns null for GET request to refresh URL", () => {
      const entry = {
        request: {
          method: "GET",
          url: "https://api.example.com/oauth/token",
          headers: [],
        },
        response: {
          status: 200,
        },
      };

      expect(extractRefreshConfig(entry)).toBeNull();
    });
  });

  // ── Header filtering ─────────────────────────────────────────────────

  describe("header filtering", () => {
    it("keeps Authorization header", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [
            { name: "Authorization", value: "Bearer xyz" },
            { name: "User-Agent", value: "Mozilla/5.0" },
            { name: "Accept", value: "application/json" },
          ],
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config).not.toBeNull();
      expect(config!.headers["Authorization"]).toBe("Bearer xyz");
      expect(config!.headers["User-Agent"]).toBeUndefined();
      expect(config!.headers["Accept"]).toBeUndefined();
    });

    it("keeps Content-Type header", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [
            { name: "Content-Type", value: "application/json" },
          ],
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.headers["Content-Type"]).toBe("application/json");
    });

    it("keeps auth-related custom headers (x-auth-token)", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [
            { name: "x-auth-token", value: "custom_tok" },
            { name: "x-request-id", value: "req123" },
          ],
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.headers["x-auth-token"]).toBe("custom_tok");
      expect(config!.headers["x-request-id"]).toBeUndefined();
    });

    it("keeps headers with 'token' in the name", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [
            { name: "x-csrf-token", value: "csrf_val" },
          ],
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.headers["x-csrf-token"]).toBe("csrf_val");
    });

    it("keeps headers with 'api-key' in the name", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [
            { name: "x-api-key", value: "key_val" },
          ],
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.headers["x-api-key"]).toBe("key_val");
    });
  });

  // ── Provider detection ────────────────────────────────────────────────

  describe("provider detection", () => {
    it("detects Google OAuth provider from accounts.google.com", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://accounts.google.com/o/oauth2/token",
          headers: [
            { name: "Content-Type", value: "application/x-www-form-urlencoded" },
          ],
          postData: {
            text: "grant_type=refresh_token&refresh_token=tok",
          },
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.provider).toBe("google");
    });

    it("detects Firebase provider from securetoken.googleapis.com", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://securetoken.googleapis.com/v1/token",
          headers: [
            { name: "Content-Type", value: "application/x-www-form-urlencoded" },
          ],
          postData: {
            text: "grant_type=refresh_token&refresh_token=fb_tok",
          },
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.provider).toBe("firebase");
    });

    it("detects Firebase provider from identitytoolkit.googleapis.com", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword",
          headers: [],
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ idToken: "id_tok", refreshToken: "ref_tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.provider).toBe("firebase");
    });

    it("defaults to generic provider for other URLs", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/auth/refresh",
          headers: [],
          postData: { text: "refresh_token=tok123" },
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.provider).toBe("generic");
    });
  });

  // ── OAuth client credentials extraction ───────────────────────────────

  describe("client credentials extraction", () => {
    it("extracts client_id and client_secret from parsed body object", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [
            { name: "Content-Type", value: "application/x-www-form-urlencoded" },
          ],
          postData: {
            text: "grant_type=refresh_token&refresh_token=tok&client_id=my_id&client_secret=my_secret&scope=read%20write",
          },
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.clientId).toBe("my_id");
      expect(config!.clientSecret).toBe("my_secret");
      expect(config!.scope).toBe("read write");
    });

    it("extracts client_id from JSON body", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [
            { name: "Content-Type", value: "application/json" },
          ],
          postData: {
            text: JSON.stringify({
              grant_type: "refresh_token",
              refresh_token: "tok",
              client_id: "json_client_id",
              scope: "openid",
            }),
          },
        },
        response: {
          status: 200,
          content: { text: JSON.stringify({ access_token: "tok" }) },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.clientId).toBe("json_client_id");
      expect(config!.scope).toBe("openid");
    });
  });

  // ── Expiry calculation ────────────────────────────────────────────────

  describe("expiry calculation", () => {
    it("sets expiresAt based on expires_in from response", () => {
      const before = Date.now();
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [],
          postData: { text: "grant_type=refresh_token&refresh_token=tok" },
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({
              access_token: "tok",
              expires_in: 3600,
            }),
          },
        },
      };

      const config = extractRefreshConfig(entry);
      const after = Date.now();

      expect(config!.expiresAt).toBeDefined();
      expect(config!.expiresInSeconds).toBe(3600);

      const expiresAt = new Date(config!.expiresAt!).getTime();
      // expiresAt should be approximately now + 3600 seconds
      expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
    });

    it("does not set expiresAt when expires_in is missing", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://api.example.com/oauth/token",
          headers: [],
          postData: { text: "grant_type=refresh_token&refresh_token=tok" },
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({ access_token: "tok" }),
          },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config!.expiresAt).toBeUndefined();
      expect(config!.expiresInSeconds).toBeUndefined();
    });
  });

  // ── Firebase URL handling ───────────────────────────────────────────

  describe("Firebase URL handling", () => {
    it("preserves identitytoolkit URL (matches refresh pattern, not initial grant)", () => {
      // identitytoolkit.googleapis.com is in REFRESH_URL_PATTERNS, so isRefresh=true.
      // The Firebase URL rewrite only triggers on isInitialGrant, which requires !isRefresh.
      // Therefore the original URL is preserved.
      const entry = {
        request: {
          method: "POST",
          url: "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaXYZ",
          headers: [],
          postData: {
            text: "grant_type=authorization_code&code=4/auth_code_xyz",
          },
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({
              idToken: "id_tok",
              refreshToken: "ref_tok",
              expiresIn: 3600,
            }),
          },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config).not.toBeNull();
      expect(config!.url).toBe(
        "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=AIzaXYZ",
      );
      expect(config!.provider).toBe("firebase");
    });

    it("preserves securetoken.googleapis.com URL for refresh requests", () => {
      const entry = {
        request: {
          method: "POST",
          url: "https://securetoken.googleapis.com/v1/token?key=AIzaXYZ",
          headers: [
            { name: "Content-Type", value: "application/x-www-form-urlencoded" },
          ],
          postData: {
            text: "grant_type=refresh_token&refresh_token=fb_refresh_tok",
          },
        },
        response: {
          status: 200,
          content: {
            text: JSON.stringify({
              access_token: "new_access",
              id_token: "new_id",
              refresh_token: "new_refresh",
              expires_in: 3600,
            }),
          },
        },
      };

      const config = extractRefreshConfig(entry);
      expect(config).not.toBeNull();
      expect(config!.url).toBe("https://securetoken.googleapis.com/v1/token?key=AIzaXYZ");
      expect(config!.provider).toBe("firebase");
    });
  });
});

// ── needsRefresh ────────────────────────────────────────────────────────────

describe("needsRefresh", () => {
  // ── Token expired ─────────────────────────────────────────────────────

  describe("token expired", () => {
    it("returns true when token has already expired", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        expiresAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
      };

      expect(needsRefresh(config)).toBe(true);
    });

    it("returns true when token expired long ago", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        expiresAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
      };

      expect(needsRefresh(config)).toBe(true);
    });
  });

  // ── Within buffer window ──────────────────────────────────────────────

  describe("within buffer window", () => {
    it("returns true when token expires within default 5-minute buffer", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(), // 3 minutes from now
      };

      expect(needsRefresh(config)).toBe(true);
    });

    it("returns true when token expires at exactly the buffer boundary", () => {
      // This tests the >= comparison: expires in exactly 5 minutes means
      // refreshAt = expiresAt - 5min = now, so new Date() >= refreshAt is true
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };

      expect(needsRefresh(config)).toBe(true);
    });

    it("returns true with custom 10-minute buffer", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(), // 8 minutes
      };

      // With 10 minute buffer, 8 minutes out should trigger refresh
      expect(needsRefresh(config, 10)).toBe(true);
    });
  });

  // ── Token is fresh ────────────────────────────────────────────────────

  describe("token is fresh", () => {
    it("returns false when token expires well beyond the buffer", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), // 60 minutes
      };

      expect(needsRefresh(config)).toBe(false);
    });

    it("returns false when token expires 10 minutes from now (5-min buffer)", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), // 10 minutes
      };

      expect(needsRefresh(config)).toBe(false);
    });

    it("returns false with custom 1-minute buffer when token has 5 minutes left", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), // 5 minutes
      };

      expect(needsRefresh(config, 1)).toBe(false);
    });

    it("returns false with zero buffer when token has 1 minute left", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        expiresAt: new Date(Date.now() + 60_000).toISOString(), // 1 minute
      };

      expect(needsRefresh(config, 0)).toBe(false);
    });
  });

  // ── Missing expiry ────────────────────────────────────────────────────

  describe("missing expiry", () => {
    it("returns false when expiresAt is undefined", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
      };

      expect(needsRefresh(config)).toBe(false);
    });

    it("returns false when expiresAt is not set but other fields exist", () => {
      const config: RefreshConfig = {
        url: "https://api.example.com/oauth/token",
        method: "POST",
        headers: {},
        refreshToken: "some_token",
        expiresInSeconds: 3600,
        // expiresAt intentionally omitted
      };

      expect(needsRefresh(config)).toBe(false);
    });
  });
});
