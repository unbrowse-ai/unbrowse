import { describe, expect, test } from "bun:test";
import { resolveAuthTokens, _clearTokenCacheForTests } from "../src/execution/token-resolver.js";
import type { AuthTokenBinding } from "../src/types/index.js";

describe("resolveAuthTokens - cookie source", () => {
  test("extracts ct0 cookie → x-csrf-token header", async () => {
    _clearTokenCacheForTests();
    const binding: AuthTokenBinding = {
      param_name: "x-csrf-token",
      param_location: "header",
      sources: [{ kind: "cookie", cookie_names: ["ct0"] }],
    };
    const resolved = await resolveAuthTokens([binding], {
      cookies: [{ name: "ct0", value: "abc123XYZ_fresh_csrf_token", domain: ".example.com" }],
      authHeaders: {},
    });
    expect(resolved.headers["x-csrf-token"]).toBe("abc123XYZ_fresh_csrf_token");
  });

  test("strips enclosing quotes from cookie values", async () => {
    _clearTokenCacheForTests();
    const binding: AuthTokenBinding = {
      param_name: "x-xsrf-token",
      param_location: "header",
      sources: [{ kind: "cookie", cookie_names: ["XSRF-TOKEN"] }],
    };
    const resolved = await resolveAuthTokens([binding], {
      cookies: [{ name: "XSRF-TOKEN", value: `"quoted-token-value-1234"`, domain: ".example.com" }],
      authHeaders: {},
    });
    expect(resolved.headers["x-xsrf-token"]).toBe("quoted-token-value-1234");
  });

  test("falls through to next source when cookie missing", async () => {
    _clearTokenCacheForTests();
    const binding: AuthTokenBinding = {
      param_name: "x-api-key",
      param_location: "header",
      sources: [
        { kind: "cookie", cookie_names: ["missing-cookie"] },
        { kind: "cookie", cookie_names: ["fallback-cookie"] },
      ],
    };
    const resolved = await resolveAuthTokens([binding], {
      cookies: [{ name: "fallback-cookie", value: "fallback-value-xyz-1234567890", domain: ".example.com" }],
      authHeaders: {},
    });
    expect(resolved.headers["x-api-key"]).toBe("fallback-value-xyz-1234567890");
  });
});

describe("resolveAuthTokens - live HTML rescrape (gated)", () => {
  const gated = process.env.UNBROWSE_E2E === "1";
  test.skipIf(!gated)("rescapes Rails csrf-token meta from rubygems.org", async () => {
    _clearTokenCacheForTests();
    const binding: AuthTokenBinding = {
      param_name: "x-csrf-token",
      param_location: "header",
      sources: [{ kind: "html-meta", meta_name: "csrf-token", meta_attr: "content" }],
    };
    const resolved = await resolveAuthTokens([binding], {
      triggerUrl: "https://rubygems.org",
      cookies: [],
      authHeaders: {},
    });
    expect(resolved.headers["x-csrf-token"]).toBeDefined();
    expect(resolved.headers["x-csrf-token"].length).toBeGreaterThan(40);
  });
});

describe("resolveAuthTokens - body/query placement", () => {
  test("routes resolved value to body bucket", async () => {
    _clearTokenCacheForTests();
    const binding: AuthTokenBinding = {
      param_name: "authenticity_token",
      param_location: "body",
      sources: [{ kind: "cookie", cookie_names: ["_csrf"] }],
    };
    const resolved = await resolveAuthTokens([binding], {
      cookies: [{ name: "_csrf", value: "rails-auth-token-value-12345", domain: ".example.com" }],
      authHeaders: {},
    });
    expect(resolved.body["authenticity_token"]).toBe("rails-auth-token-value-12345");
    expect(resolved.headers["authenticity_token"]).toBeUndefined();
  });

  test("routes resolved value to query bucket", async () => {
    _clearTokenCacheForTests();
    const binding: AuthTokenBinding = {
      param_name: "api_key",
      param_location: "query",
      sources: [{ kind: "cookie", cookie_names: ["apikey"] }],
    };
    const resolved = await resolveAuthTokens([binding], {
      cookies: [{ name: "apikey", value: "q-string-api-key-value-xyz999", domain: ".example.com" }],
      authHeaders: {},
    });
    expect(resolved.query["api_key"]).toBe("q-string-api-key-value-xyz999");
  });
});
