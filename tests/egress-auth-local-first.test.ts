/**
 * B1 witness — auth-local-first egress. The runnable proof for the firmament
 * (Gen 1:6-7): an auth-bearing request never reaches the terminating server
 * `/v1/proxy` tier, while a non-auth request still does (the gate discriminates,
 * it does not vacuously block everything).
 *
 * Mutation-proof: deleting the `!authBearing` guard in egress-chain.ts, or the
 * `isAuthBearing` backstop in server-proxy-fallback.ts, re-introduces the leak —
 * and the "never reaches /v1/proxy" assertions below go red.
 *
 * CHECK: bun test tests/egress-auth-local-first.test.ts && bun run check:privacy
 *        && bun scripts/surface-gate.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isAuthBearing } from "../src/execution/auth-bearing";
import { egressChain, egressFetch } from "../src/execution/egress-chain";
import { serverProxyFallback } from "../src/execution/server-proxy-fallback";

// ── AC2: classifier witness ────────────────────────────────────────────────
describe("isAuthBearing classifier (B1 firmament)", () => {
  const cases: Array<[Record<string, string>, boolean, string]> = [
    [{ Authorization: "Bearer eyJabc" }, true, "Authorization"],
    [{ authorization: "Bearer eyJabc" }, true, "authorization (case-insensitive)"],
    [{ Cookie: "sid=abc" }, true, "Cookie"],
    [{ "X-Api-Key": "k_123" }, true, "X-Api-Key"],
    [{ "Proxy-Authorization": "Basic eyJ" }, true, "Proxy-Authorization"],
    [{ "X-Custom-Auth": "Token abc123" }, true, "credential-shaped value in a non-standard header"],
    [{ "X-Request-Id": "req-123" }, true, "any custom X-* header (non-benign) is auth-bearing"],
    [{ "X-Csrf-Token": "t0ken" }, true, "csrf token header is auth-bearing"],
    [{ "X-Amz-Date": "20260617" }, true, "vendor signing header is auth-bearing"],
    [{ Accept: "application/json" }, false, "Accept is benign"],
    [{ "User-Agent": "Mozilla/5.0" }, false, "User-Agent is benign"],
    // Referer/Origin are NOT benign — they carry the authenticated source URL / private app identity.
    [{ Referer: "https://mybank.com/dashboard?session=abc123" }, true, "Referer (authenticated source URL) is auth-bearing"],
    [{ Origin: "https://internal-app.company.com" }, true, "Origin (private app identity) is auth-bearing"],
    [{ "X-Custom": "Basic dXNlcjpwYXNzd29yZA==" }, true, "Basic-auth value in a header is auth-bearing"],
    [{ "X-Custom": "Negotiate YIIZ..." }, true, "Negotiate/Kerberos value in a header is auth-bearing"],
    [
      { "User-Agent": "Mozilla/5.0 (compatible; unbrowse/1.0)", Accept: "text/html" },
      false,
      "a real anonymous public GET (DDG sends only User-Agent + Accept) stays eligible for the server tier",
    ],
    [{}, false, "no headers"],
  ];
  for (const [headers, expected, label] of cases) {
    test(`${label} → ${expected}`, () => {
      expect(isAuthBearing(headers)).toBe(expected);
    });
  }

  test("a sealed credential fill forces auth-bearing", () => {
    expect(isAuthBearing({ Accept: "application/json" }, { sealedFill: true })).toBe(true);
  });
  test("a storage-derived (storageBound) request forces auth-bearing", () => {
    expect(isAuthBearing({ "User-Agent": "Mozilla/5.0" }, { storageBound: true })).toBe(true);
  });
  test("null / undefined headers are not auth-bearing", () => {
    expect(isAuthBearing(undefined)).toBe(false);
    expect(isAuthBearing(null)).toBe(false);
  });

  // Fail-safe on a Headers object (Object.entries(Headers) === [] would miss it).
  test("a Headers object carrying a credential is auth-bearing (fails safe)", () => {
    expect(isAuthBearing(new Headers({ Authorization: "Bearer secret", Cookie: "sid=abc" }))).toBe(true);
  });
  test("a Headers object with only benign headers is not auth-bearing", () => {
    expect(isAuthBearing(new Headers({ "User-Agent": "Mozilla/5.0", Accept: "*/*" }))).toBe(false);
  });

  // Drift guard (Matt 7:24 — the sign the foundation still stands): these headers
  // must ALWAYS be auth-bearing. If a future edit accidentally widens the benign
  // allowlist to include any of them, this goes red.
  test("no sensitive/credential header is ever treated as benign", () => {
    const mustBeAuth = [
      "authorization", "Authorization", "cookie", "Cookie", "set-cookie",
      "x-api-key", "x-apikey", "api-key", "x-auth-token", "x-access-token",
      "x-csrf-token", "csrf-token", "x-xsrf-token", "proxy-authorization",
      "x-amz-security-token", "x-amz-date", "x-goog-api-key", "authentication",
      "x-session-id", "x-session-token", "x-id-token",
    ];
    for (const h of mustBeAuth) {
      expect(isAuthBearing({ [h]: "value" })).toBe(true);
    }
  });
});

// ── AC1: auth-exclusion witness (+ positive control) ───────────────────────
describe("egress auth-exclusion: server tier never sees a credential", () => {
  let calls: string[];
  let origFetch: typeof fetch;
  const origEnv = { ...process.env };

  beforeEach(() => {
    calls = [];
    origFetch = globalThis.fetch;
    // A resolvable key so the SERVER tier actually attempts /v1/proxy in the
    // positive control; not local-only, not direct-egress (those short-circuit).
    process.env.UNBROWSE_API_KEY = "test-key-b1";
    delete process.env.UNBROWSE_LOCAL_ONLY;
    delete process.env.UNBROWSE_DIRECT_EGRESS;
    delete process.env.UNBROWSE_PROXY_URL; // keep the client-proxy tier out of the way
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    process.env = { ...origEnv };
  });

  /** LOCAL tier (target URL) returns a hard block; /v1/proxy serves cleanly. */
  function stubFetch() {
    globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/v1/proxy")) {
        return new Response(JSON.stringify({ status: 200, body: "served-by-server" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("blocked", { status: 403 });
    }) as unknown as typeof fetch;
  }

  const hitServerProxy = () => calls.some((c) => c.includes("/v1/proxy"));

  test("auth-bearing request blocked locally NEVER escalates to the server tier", async () => {
    stubFetch();
    const out = await egressChain(
      { url: "https://api.site.com/data", headers: { Authorization: "Bearer secret", Cookie: "sid=abc" } },
      { allowClientProxy: false },
    );
    expect(hitServerProxy()).toBe(false); // the credential never crossed unbrowse's servers
    expect(out.blocked).toBe(true);
    expect(out.tier).toBe("local");
    expect(out.authExcluded).toBe(true); // honest: excluded by design, not silently unavailable
  });

  test("positive control: the SAME path WITHOUT auth DOES reach the server tier", async () => {
    stubFetch();
    const out = await egressChain(
      { url: "https://api.site.com/data", headers: { Accept: "application/json" } },
      { allowClientProxy: false },
    );
    expect(hitServerProxy()).toBe(true); // gate discriminates — non-auth still escalates
    expect(out.tier).toBe("server");
    expect(out.body).toBe("served-by-server");
    expect(out.authExcluded).toBeUndefined();
  });

  test("backstop: serverProxyFallback refuses an auth-bearing request directly (any caller)", async () => {
    stubFetch();
    const refused = await serverProxyFallback(
      { url: "https://api.site.com/data", headers: { Authorization: "Bearer secret" } },
      { apiKey: "test-key-b1" },
    );
    expect(refused).toBeNull();
    expect(hitServerProxy()).toBe(false);
  });

  test("backstop discriminates: a non-auth request still reaches /v1/proxy", async () => {
    stubFetch();
    const served = await serverProxyFallback(
      { url: "https://api.site.com/data", headers: { Accept: "application/json" } },
      { apiKey: "test-key-b1" },
    );
    expect(served?.body).toBe("served-by-server");
    expect(hitServerProxy()).toBe(true);
  });

  // ── the other mouth: egressFetch (web-search adapter, a different caller) ──
  test("egressFetch: an auth-bearing request never reaches /v1/proxy", async () => {
    stubFetch();
    await egressFetch("https://api.site.com/data", {
      headers: { Authorization: "Bearer secret", Cookie: "sid=abc" },
    });
    expect(hitServerProxy()).toBe(false);
  });

  test("egressFetch: a non-auth request still reaches /v1/proxy (adapter positive control)", async () => {
    stubFetch();
    const res = await egressFetch("https://api.site.com/data", {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
    });
    expect(hitServerProxy()).toBe(true);
    expect(res.headers.get("x-egress-tier")).toBe("server");
  });

  // ── adversarial: disguises / casing must fail SAFE (treated as auth) ──
  test("adversarial: upper-cased credential header is still excluded", async () => {
    stubFetch();
    const out = await egressChain(
      { url: "https://api.site.com/data", headers: { AUTHORIZATION: "Bearer secret" } },
      { allowClientProxy: false },
    );
    expect(hitServerProxy()).toBe(false);
    expect(out.authExcluded).toBe(true);
  });

  test("adversarial: a credential-shaped value inside a benign header is excluded", async () => {
    stubFetch();
    const out = await egressChain(
      { url: "https://api.site.com/data", headers: { "Content-Type": "Bearer leaked-token" } },
      { allowClientProxy: false },
    );
    expect(hitServerProxy()).toBe(false);
    expect(out.authExcluded).toBe(true);
  });
});
