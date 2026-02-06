/**
 * Unit tests for auth-extractor.ts
 *
 * Tests guessAuthMethod() and generateAuthInfo() — two pure functions
 * that identify auth mechanisms from headers/cookies and build auth.json data.
 *
 * guessAuthMethod priority order:
 *   1. Bearer token (value starts with "bearer ")
 *   2. API key headers (api-key, apikey, x-api-key, x-key)
 *   3. JWT headers (jwt, id-token, id_token)
 *   4. Authorization header (Basic, Digest, or generic)
 *   5. Session/CSRF headers
 *   6. AWS Signature (amz)
 *   7. Mudra token
 *   8. OAuth headers
 *   9. Generic auth/token headers
 *  10. Custom x-* headers
 *  11. Cookie-based auth (exact name match)
 *  12. Cookie-based auth (pattern match)
 *  13. Unknown fallback
 */

import { describe, it, expect } from "bun:test";
import { guessAuthMethod, generateAuthInfo } from "../../auth-extractor.js";
import { makeApiData } from "../helpers.js";

// ── guessAuthMethod ──────────────────────────────────────────────────────

describe("guessAuthMethod", () => {
  describe("Bearer token detection", () => {
    it("detects standard Bearer token in authorization header", () => {
      expect(guessAuthMethod(
        { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def" },
        {},
      )).toBe("Bearer Token");
    });

    it("detects Bearer token case-insensitively", () => {
      expect(guessAuthMethod(
        { Authorization: "bearer abc123" },
        {},
      )).toBe("Bearer Token");
    });

    it("detects Bearer token in non-standard header name", () => {
      expect(guessAuthMethod(
        { "x-custom-auth": "Bearer xyz789" },
        {},
      )).toBe("Bearer Token");
    });

    it("Bearer takes priority over api-key header", () => {
      expect(guessAuthMethod(
        { "x-api-key": "key123", authorization: "Bearer token456" },
        {},
      )).toBe("Bearer Token");
    });
  });

  describe("API Key detection", () => {
    it("detects x-api-key header", () => {
      expect(guessAuthMethod(
        { "x-api-key": "key123abc" },
        {},
      )).toBe("API Key (x-api-key)");
    });

    it("detects api-key in header name", () => {
      expect(guessAuthMethod(
        { "custom-api-key": "key456" },
        {},
      )).toBe("API Key (custom-api-key)");
    });

    it("detects apikey in header name", () => {
      expect(guessAuthMethod(
        { "x-apikey": "key789" },
        {},
      )).toBe("API Key (x-apikey)");
    });

    it("detects x-key header", () => {
      expect(guessAuthMethod(
        { "x-key": "mykey" },
        {},
      )).toBe("API Key (x-key)");
    });

    it("API key takes priority over JWT headers", () => {
      expect(guessAuthMethod(
        { "x-api-key": "key1", "x-jwt": "tok1" },
        {},
      )).toBe("API Key (x-api-key)");
    });
  });

  describe("JWT detection", () => {
    it("detects jwt in header name", () => {
      expect(guessAuthMethod(
        { "x-jwt": "eyJhbGciOiJIUzI1NiJ9" },
        {},
      )).toBe("JWT (x-jwt)");
    });

    it("detects id-token header", () => {
      expect(guessAuthMethod(
        { "x-id-token": "idtokval" },
        {},
      )).toBe("JWT (x-id-token)");
    });

    it("detects id_token header", () => {
      expect(guessAuthMethod(
        { "x-id_token": "idtokval2" },
        {},
      )).toBe("JWT (x-id_token)");
    });
  });

  describe("Authorization header variants", () => {
    it("detects Basic auth", () => {
      expect(guessAuthMethod(
        { authorization: "Basic dXNlcjpwYXNz" },
        {},
      )).toBe("Basic Auth");
    });

    it("detects Digest auth", () => {
      expect(guessAuthMethod(
        { authorization: "Digest username=\"user\", realm=\"test\"" },
        {},
      )).toBe("Digest Auth");
    });

    it("detects generic Authorization header (non-Bearer/Basic/Digest)", () => {
      expect(guessAuthMethod(
        { authorization: "Token abc123" },
        {},
      )).toBe("Authorization Header");
    });

    it("handles Authorization with capital A", () => {
      expect(guessAuthMethod(
        { Authorization: "Basic dXNlcjpwYXNz" },
        {},
      )).toBe("Basic Auth");
    });
  });

  describe("Session/CSRF token detection", () => {
    it("detects session header", () => {
      expect(guessAuthMethod(
        { "x-session-id": "sess123" },
        {},
      )).toBe("Session Token (x-session-id)");
    });

    it("detects csrf header", () => {
      expect(guessAuthMethod(
        { "x-csrf-token": "csrf456" },
        {},
      )).toBe("Session Token (x-csrf-token)");
    });

    it("detects xsrf header", () => {
      expect(guessAuthMethod(
        { "x-xsrf-token": "xsrf789" },
        {},
      )).toBe("Session Token (x-xsrf-token)");
    });
  });

  describe("AWS Signature detection", () => {
    it("detects AWS auth via amz header", () => {
      expect(guessAuthMethod(
        { "x-amz-security-token": "awstoken" },
        {},
      )).toBe("AWS Signature");
    });

    it("detects AWS auth via x-amz-date header", () => {
      expect(guessAuthMethod(
        { "x-amz-date": "20230101T000000Z" },
        {},
      )).toBe("AWS Signature");
    });
  });

  describe("Mudra token detection", () => {
    it("detects mudra token (exact key match)", () => {
      expect(guessAuthMethod(
        { mudra: "user123--token456" },
        {},
      )).toBe("Mudra Token");
    });
  });

  describe("OAuth detection", () => {
    it("detects oauth header", () => {
      expect(guessAuthMethod(
        { "x-oauth-token": "oauthval" },
        {},
      )).toBe("OAuth (x-oauth-token)");
    });
  });

  describe("Generic auth/token header detection", () => {
    it("detects generic auth header", () => {
      expect(guessAuthMethod(
        { "x-custom-auth-header": "val1" },
        {},
      )).toBe("Custom Token (x-custom-auth-header)");
    });

    it("detects generic token header", () => {
      expect(guessAuthMethod(
        { "x-access-token": "val2" },
        {},
      )).toBe("Custom Token (x-access-token)");
    });
  });

  describe("Custom x-* header fallback", () => {
    it("falls back to custom x-* header when no auth patterns match", () => {
      expect(guessAuthMethod(
        { "x-request-id": "rid123" },
        {},
      )).toBe("Custom Header (x-request-id)");
    });

    it("returns first custom x-* header", () => {
      expect(guessAuthMethod(
        { "x-custom-one": "a", "x-custom-two": "b" },
        {},
      )).toMatch(/^Custom Header \(x-custom-/);
    });
  });

  describe("Cookie-based auth detection", () => {
    it("detects session cookie (exact name match)", () => {
      expect(guessAuthMethod({}, { session: "sess123" })).toBe("Cookie-based (session)");
    });

    it("detects sessionid cookie", () => {
      expect(guessAuthMethod({}, { sessionid: "id123" })).toBe("Cookie-based (sessionid)");
    });

    it("detects token cookie", () => {
      expect(guessAuthMethod({}, { token: "tok123" })).toBe("Cookie-based (token)");
    });

    it("detects authtoken cookie", () => {
      expect(guessAuthMethod({}, { authtoken: "at123" })).toBe("Cookie-based (authtoken)");
    });

    it("detects jwt cookie", () => {
      expect(guessAuthMethod({}, { jwt: "jwtval" })).toBe("Cookie-based (jwt)");
    });

    it("detects auth cookie", () => {
      expect(guessAuthMethod({}, { auth: "authval" })).toBe("Cookie-based (auth)");
    });

    it("detects access_token cookie", () => {
      expect(guessAuthMethod({}, { access_token: "at_val" })).toBe("Cookie-based (access_token)");
    });

    it("detects id_token cookie", () => {
      expect(guessAuthMethod({}, { id_token: "idt_val" })).toBe("Cookie-based (id_token)");
    });

    it("detects refresh_token cookie", () => {
      expect(guessAuthMethod({}, { refresh_token: "rt_val" })).toBe("Cookie-based (refresh_token)");
    });

    it("cookie name matching is case-insensitive", () => {
      expect(guessAuthMethod({}, { SESSION: "sess123" })).toBe("Cookie-based (session)");
    });

    it("falls back to pattern-matched auth cookie", () => {
      expect(guessAuthMethod({}, { "my-auth-cookie": "val" })).toBe("Cookie-based (my-auth-cookie)");
    });

    it("falls back to pattern-matched token cookie", () => {
      expect(guessAuthMethod({}, { "app_token_v2": "val" })).toBe("Cookie-based (app_token_v2)");
    });

    it("falls back to pattern-matched session cookie", () => {
      expect(guessAuthMethod({}, { "app_session_v2": "val" })).toBe("Cookie-based (app_session_v2)");
    });
  });

  describe("Unknown fallback", () => {
    it("returns unknown when no auth headers or cookies", () => {
      expect(guessAuthMethod({}, {})).toBe("Unknown (may need login)");
    });

    it("returns unknown when cookies have no auth-related names", () => {
      expect(guessAuthMethod({}, { theme: "dark", lang: "en" })).toBe("Unknown (may need login)");
    });
  });

  describe("priority ordering", () => {
    it("Bearer beats everything", () => {
      expect(guessAuthMethod(
        { authorization: "Bearer tok", "x-api-key": "key", "x-jwt": "jwt", "x-session-id": "s" },
        { session: "s1" },
      )).toBe("Bearer Token");
    });

    it("API key beats JWT when no Bearer present", () => {
      expect(guessAuthMethod(
        { "x-api-key": "key1", "x-jwt": "jwt1" },
        {},
      )).toBe("API Key (x-api-key)");
    });

    it("JWT beats Authorization header", () => {
      expect(guessAuthMethod(
        { "x-jwt": "jwtval", authorization: "Token abc" },
        {},
      )).toBe("JWT (x-jwt)");
    });

    it("Authorization header beats session/csrf", () => {
      expect(guessAuthMethod(
        { authorization: "Token abc", "x-csrf-token": "csrf1" },
        {},
      )).toBe("Authorization Header");
    });

    it("Session/CSRF beats AWS Signature", () => {
      expect(guessAuthMethod(
        { "x-session-id": "s1", "x-amz-date": "d1" },
        {},
      )).toBe("Session Token (x-session-id)");
    });

    it("headers take priority over cookies", () => {
      expect(guessAuthMethod(
        { "x-request-id": "rid" },
        { session: "sess" },
      )).toBe("Custom Header (x-request-id)");
    });
  });
});

// ── generateAuthInfo ──────────────────────────────────────────────────────

describe("generateAuthInfo", () => {
  describe("basic structure", () => {
    it("returns correct service and baseUrl", () => {
      const data = makeApiData({ service: "my-api", baseUrl: "https://api.example.com" });
      const result = generateAuthInfo("my-api", data);
      expect(result.service).toBe("my-api");
      expect(result.baseUrl).toBe("https://api.example.com");
    });

    it("includes authMethod from data", () => {
      const data = makeApiData({ authMethod: "Bearer Token" });
      const result = generateAuthInfo("test", data);
      expect(result.authMethod).toBe("Bearer Token");
    });

    it("includes timestamp as ISO string", () => {
      const data = makeApiData();
      const result = generateAuthInfo("test", data);
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("notes is always an array", () => {
      const data = makeApiData();
      const result = generateAuthInfo("test", data);
      expect(Array.isArray(result.notes)).toBe(true);
    });
  });

  describe("header categorization", () => {
    it("categorizes API key headers in notes", () => {
      const data = makeApiData({
        authHeaders: { "x-api-key": "key123" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.headers).toEqual({ "x-api-key": "key123" });
      expect(result.notes.some(n => n.includes("API keys") && n.includes("x-api-key"))).toBe(true);
    });

    it("categorizes auth token headers in notes", () => {
      const data = makeApiData({
        authHeaders: { authorization: "Bearer tok123" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("Auth tokens") && n.includes("authorization"))).toBe(true);
    });

    it("categorizes session headers in notes", () => {
      const data = makeApiData({
        authHeaders: { "x-session-id": "sess1" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("Session headers") && n.includes("x-session-id"))).toBe(true);
    });

    it("categorizes custom headers in notes", () => {
      const data = makeApiData({
        authHeaders: { "x-request-id": "rid" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("Custom headers") && n.includes("x-request-id"))).toBe(true);
    });

    it("categorizes jwt header as auth token", () => {
      const data = makeApiData({
        authHeaders: { "x-jwt-token": "jwtval" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("Auth tokens"))).toBe(true);
    });

    it("categorizes csrf header with 'token' in name as auth token (token check runs first)", () => {
      const data = makeApiData({
        authHeaders: { "x-csrf-token": "csrf1" },
      });
      const result = generateAuthInfo("test", data);
      // "x-csrf-token" contains "token", which is checked before "csrf" in the code
      expect(result.notes.some(n => n.includes("Auth tokens"))).toBe(true);
    });

    it("categorizes pure csrf header as session", () => {
      const data = makeApiData({
        authHeaders: { "x-csrf": "csrf1" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("Session headers"))).toBe(true);
    });

    it("categorizes apikey header as API key", () => {
      const data = makeApiData({
        authHeaders: { "x-apikey": "ak1" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("API keys"))).toBe(true);
    });

    it("stores all auth headers", () => {
      const data = makeApiData({
        authHeaders: { "x-api-key": "k1", authorization: "Bearer t1", "x-custom": "c1" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.headers).toEqual({
        "x-api-key": "k1",
        authorization: "Bearer t1",
        "x-custom": "c1",
      });
      expect(result.notes.some(n => n.includes("3 auth header(s)"))).toBe(true);
    });

    it("does not set headers property when authHeaders is empty", () => {
      const data = makeApiData({ authHeaders: {} });
      const result = generateAuthInfo("test", data);
      expect(result.headers).toBeUndefined();
    });
  });

  describe("mudra token handling", () => {
    it("extracts mudra token", () => {
      const data = makeApiData({
        authHeaders: { mudra: "user123--sessiontoken456" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.mudraToken).toBe("user123--sessiontoken456");
      expect(result.notes.some(n => n.includes("mudra token extracted"))).toBe(true);
    });

    it("extracts userId from mudra token with -- separator", () => {
      const data = makeApiData({
        authHeaders: { mudra: "user999--tokenabc" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.userId).toBe("user999");
    });

    it("does not extract userId when mudra has no -- separator", () => {
      const data = makeApiData({
        authHeaders: { mudra: "simpletokenwithoutdash" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.mudraToken).toBe("simpletokenwithoutdash");
      expect(result.userId).toBeUndefined();
    });
  });

  describe("outlet ID handling", () => {
    it("extracts single outlet ID from authInfo", () => {
      const data = makeApiData({
        authInfo: { request_header_outletid: "outlet1" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.outletIds).toEqual(["outlet1"]);
      expect(result.headers?.outletid).toBe("outlet1");
      expect(result.notes.some(n => n.includes("1 outlet ID(s)"))).toBe(true);
    });

    it("extracts multiple comma-separated outlet IDs", () => {
      const data = makeApiData({
        authInfo: { request_header_outletid: "outlet1,outlet2,outlet3" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.outletIds).toEqual(["outlet1", "outlet2", "outlet3"]);
      expect(result.notes.some(n => n.includes("3 outlet ID(s)"))).toBe(true);
    });

    it("creates headers object for outlet ID even when authHeaders is empty", () => {
      const data = makeApiData({
        authHeaders: {},
        authInfo: { request_header_outletid: "outlet1" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.headers).toEqual({ outletid: "outlet1" });
    });
  });

  describe("cookie handling", () => {
    it("stores all cookies", () => {
      const data = makeApiData({
        cookies: { session: "s1", theme: "dark" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.cookies).toEqual({ session: "s1", theme: "dark" });
    });

    it("notes auth-related cookies separately", () => {
      const data = makeApiData({
        cookies: { session: "s1", auth_token: "at1", theme: "dark" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("2 auth cookie(s)"))).toBe(true);
      expect(result.notes.some(n => n.includes("3 total cookie(s)"))).toBe(true);
    });

    it("does not set cookies property when cookies is empty", () => {
      const data = makeApiData({ cookies: {} });
      const result = generateAuthInfo("test", data);
      expect(result.cookies).toBeUndefined();
    });

    it("detects auth cookie with 'access' in name", () => {
      const data = makeApiData({
        cookies: { access_key: "ak1" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("1 auth cookie(s)"))).toBe(true);
    });

    it("detects auth cookie with 'jwt' in name", () => {
      const data = makeApiData({
        cookies: { jwt_refresh: "jr1" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("1 auth cookie(s)"))).toBe(true);
    });

    it("detects auth cookie with 'id_token' in name", () => {
      const data = makeApiData({
        cookies: { id_token: "idt1" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.notes.some(n => n.includes("1 auth cookie(s)"))).toBe(true);
    });

    it("does not count non-auth cookies as auth cookies", () => {
      const data = makeApiData({
        cookies: { theme: "dark", lang: "en", _ga: "GA1.2.xxx" },
      });
      const result = generateAuthInfo("test", data);
      // Should not have "auth cookie(s)" note, only total
      expect(result.notes.some(n => n.includes("auth cookie(s)"))).toBe(false);
      expect(result.notes.some(n => n.includes("3 total cookie(s)"))).toBe(true);
    });
  });

  describe("authInfo passthrough", () => {
    it("includes authInfo from data (up to 50 entries)", () => {
      const data = makeApiData({
        authInfo: { key1: "val1", key2: "val2" },
      });
      const result = generateAuthInfo("test", data);
      expect(result.authInfo).toEqual({ key1: "val1", key2: "val2" });
    });

    it("truncates authInfo to 50 entries", () => {
      const bigAuthInfo: Record<string, string> = {};
      for (let i = 0; i < 60; i++) {
        bigAuthInfo[`key_${i}`] = `val_${i}`;
      }
      const data = makeApiData({ authInfo: bigAuthInfo });
      const result = generateAuthInfo("test", data);
      expect(Object.keys(result.authInfo!).length).toBe(50);
    });

    it("does not set authInfo when data.authInfo is empty", () => {
      const data = makeApiData({ authInfo: {} });
      const result = generateAuthInfo("test", data);
      expect(result.authInfo).toBeUndefined();
    });
  });

  describe("combined scenarios", () => {
    it("handles full auth data with headers, cookies, and authInfo", () => {
      const data = makeApiData({
        service: "zeemart",
        baseUrl: "https://api.zeemart.com",
        authMethod: "Mudra Token",
        authHeaders: {
          mudra: "user1--tok1",
          "x-api-key": "apikey1",
        },
        cookies: {
          session: "sess1",
          theme: "dark",
        },
        authInfo: {
          request_header_outletid: "outlet1,outlet2",
          extra_field: "extra",
        },
      });
      const result = generateAuthInfo("zeemart", data);

      expect(result.service).toBe("zeemart");
      expect(result.baseUrl).toBe("https://api.zeemart.com");
      expect(result.authMethod).toBe("Mudra Token");
      expect(result.mudraToken).toBe("user1--tok1");
      expect(result.userId).toBe("user1");
      expect(result.outletIds).toEqual(["outlet1", "outlet2"]);
      expect(result.cookies).toEqual({ session: "sess1", theme: "dark" });
      expect(result.headers?.["x-api-key"]).toBe("apikey1");
      expect(result.headers?.outletid).toBe("outlet1,outlet2");
      expect(result.authInfo?.extra_field).toBe("extra");
      expect(result.notes.length).toBeGreaterThan(0);
    });

    it("handles minimal data with no auth at all", () => {
      const data = makeApiData({
        authHeaders: {},
        cookies: {},
        authInfo: {},
      });
      const result = generateAuthInfo("empty", data);

      expect(result.service).toBe("empty");
      expect(result.notes).toEqual([]);
      expect(result.headers).toBeUndefined();
      expect(result.cookies).toBeUndefined();
      expect(result.authInfo).toBeUndefined();
      expect(result.mudraToken).toBeUndefined();
      expect(result.userId).toBeUndefined();
      expect(result.outletIds).toBeUndefined();
    });
  });
});
