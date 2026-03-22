import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isDomainMatch, getRegistrableDomain } from "../src/domain.js";
import { storeCredential, getCredential, deleteCredential } from "../src/vault/index.js";
import { findStoredAuthReference, getStoredAuth, getStoredAuthBundle, getAuthCookies } from "../src/auth/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCookie(overrides: Record<string, unknown> = {}) {
  return {
    name: "session",
    value: "abc123",
    domain: ".example.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    expires: -1, // session cookie
    ...overrides,
  };
}

/** Unix timestamp N seconds from now */
function futureExpiry(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

function pastExpiry(seconds: number): number {
  return Math.floor(Date.now() / 1000) - seconds;
}

// Clean up vault keys we create during tests
const createdKeys: string[] = [];
async function storeTestCredential(key: string, value: string) {
  createdKeys.push(key);
  await storeCredential(key, value);
}
afterEach(async () => {
  for (const key of createdKeys) {
    try { await deleteCredential(key); } catch { /* ignore */ }
  }
  createdKeys.length = 0;
});

// =====================================================================
// 1. isDomainMatch — fixed to be unidirectional
// =====================================================================

describe("isDomainMatch (unidirectional)", () => {
  it("matches exact domain", () => {
    expect(isDomainMatch("example.com", "example.com")).toBe(true);
  });

  it("matches with leading dot (cookie scope)", () => {
    expect(isDomainMatch(".example.com", "example.com")).toBe(true);
  });

  it("matches subdomain against parent cookie", () => {
    expect(isDomainMatch(".google.com", "mail.google.com")).toBe(true);
    expect(isDomainMatch("google.com", "mail.google.com")).toBe(true);
  });

  it("matches deep subdomain", () => {
    expect(isDomainMatch(".example.com", "a.b.c.example.com")).toBe(true);
  });

  it("rejects unrelated domains (the old bidirectional bug)", () => {
    // This was the bug: notgoogle.com matched google.com
    expect(isDomainMatch("notgoogle.com", "google.com")).toBe(false);
    expect(isDomainMatch("evil-example.com", "example.com")).toBe(false);
  });

  it("rejects parent matching child (unidirectional)", () => {
    // Cookie for mail.google.com should NOT match google.com
    expect(isDomainMatch("mail.google.com", "google.com")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isDomainMatch(".Example.COM", "EXAMPLE.com")).toBe(true);
    expect(isDomainMatch(".GOOGLE.com", "Mail.Google.Com")).toBe(true);
  });

  it("rejects suffix-overlapping domains", () => {
    expect(isDomainMatch("oogle.com", "google.com")).toBe(false);
    expect(isDomainMatch("xample.com", "example.com")).toBe(false);
  });
});

// =====================================================================
// 2. getRegistrableDomain
// =====================================================================

describe("getRegistrableDomain", () => {
  it("extracts registrable domain from subdomain", () => {
    expect(getRegistrableDomain("api.example.com")).toBe("example.com");
    expect(getRegistrableDomain("mail.google.com")).toBe("google.com");
  });

  it("returns domain unchanged if already registrable", () => {
    expect(getRegistrableDomain("example.com")).toBe("example.com");
  });

  it("handles ccTLDs", () => {
    expect(getRegistrableDomain("api.example.co.uk")).toBe("example.co.uk");
    expect(getRegistrableDomain("shop.store.com.br")).toBe("store.com.br");
  });

  it("handles deep subdomains", () => {
    expect(getRegistrableDomain("a.b.c.example.com")).toBe("example.com");
  });
});

// =====================================================================
// 3. Vault integration — expired cookie filtering
// =====================================================================

describe("getStoredAuth — expired cookie filtering", () => {
  it("returns session cookies (no expiry)", async () => {
    const cookies = [makeCookie({ expires: -1 })];
    await storeTestCredential("auth:example.com", JSON.stringify({ cookies }));

    const result = await getStoredAuth("example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  it("returns cookies with null expiry", async () => {
    const cookies = [makeCookie({ expires: undefined })];
    await storeTestCredential("auth:example.com", JSON.stringify({ cookies }));

    const result = await getStoredAuth("example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  it("returns cookies with future expiry", async () => {
    const cookies = [makeCookie({ expires: futureExpiry(3600) })];
    await storeTestCredential("auth:example.com", JSON.stringify({ cookies }));

    const result = await getStoredAuth("example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  it("filters out cookies with past expiry", async () => {
    const cookies = [
      makeCookie({ name: "fresh", expires: futureExpiry(3600) }),
      makeCookie({ name: "stale", expires: pastExpiry(3600) }),
    ];
    await storeTestCredential("auth:example.com", JSON.stringify({ cookies }));

    const result = await getStoredAuth("example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
    expect(result![0].name).toBe("fresh");
  });

  it("returns null and deletes key when ALL cookies are expired", async () => {
    const cookies = [
      makeCookie({ name: "old1", expires: pastExpiry(3600) }),
      makeCookie({ name: "old2", expires: pastExpiry(7200) }),
    ];
    await storeTestCredential("auth:example.com", JSON.stringify({ cookies }));

    const result = await getStoredAuth("example.com");
    expect(result).toBeNull();

    // Verify the key was deleted
    const raw = await getCredential("auth:example.com");
    expect(raw).toBeNull();
  });
});

// =====================================================================
// 4. Vault key normalization — registrable domain
// =====================================================================

describe("getStoredAuth — vault key normalization", () => {
  it("finds cookies stored under registrable domain when queried with subdomain", async () => {
    const cookies = [makeCookie({ domain: ".example.com" })];
    await storeTestCredential("auth:example.com", JSON.stringify({ cookies }));

    // Query with subdomain — should find auth:example.com
    const result = await getStoredAuth("api.example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  it("falls back to exact domain key for backward compat", async () => {
    const cookies = [makeCookie({ domain: ".api.example.com" })];
    // Old-style key with full subdomain
    await storeTestCredential("auth:api.example.com", JSON.stringify({ cookies }));

    const result = await getStoredAuth("api.example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  it("prefers registrable domain key over exact domain key", async () => {
    const regCookies = [makeCookie({ name: "from_reg", domain: ".example.com" })];
    const exactCookies = [makeCookie({ name: "from_exact", domain: ".api.example.com" })];

    await storeTestCredential("auth:example.com", JSON.stringify({ cookies: regCookies }));
    await storeTestCredential("auth:api.example.com", JSON.stringify({ cookies: exactCookies }));

    const result = await getStoredAuth("api.example.com");
    expect(result).not.toBeNull();
    expect(result![0].name).toBe("from_reg"); // registrable domain key wins
  });
});

describe("stored auth bundle resolution", () => {
  it("prefers session bundles and merges cookie-only auth fallback", async () => {
    await storeTestCredential("example.com-session", JSON.stringify({
      cookies: [
        makeCookie({ name: "session_a", domain: ".example.com" }),
        makeCookie({ name: "session_b", domain: ".www.example.com" }),
      ],
      headers: {
        "csrf-token": "ajax:123",
        authorization: "Bearer abc",
      },
    }));
    await storeTestCredential("auth:example.com", JSON.stringify({
      cookies: [makeCookie({ name: "cookie_fallback", domain: ".example.com" })],
    }));

    const result = await getStoredAuthBundle("www.example.com");
    expect(result).not.toBeNull();
    expect(result!.source_keys[0]).toBe("example.com-session");
    expect(result!.cookies.length).toBe(3);
    expect(result!.headers["csrf-token"]).toBe("ajax:123");
    expect(result!.headers.authorization).toBe("Bearer abc");
    expect(await findStoredAuthReference("www.example.com")).toBe("example.com-session");
  });
});

// =====================================================================
// 5. CSRF token detection
// =====================================================================

describe("CSRF token auto-detection", () => {
  // Test the pattern matching directly since the actual header injection
  // is in serverFetch which needs a live endpoint. We test the regex.
  const CSRF_RE = /^(ct0|csrf_token|_csrf|csrftoken|XSRF-TOKEN|_xsrf)$/i;

  it("detects Twitter ct0 token", () => {
    expect(CSRF_RE.test("ct0")).toBe(true);
  });

  it("detects common CSRF cookie names", () => {
    expect(CSRF_RE.test("csrf_token")).toBe(true);
    expect(CSRF_RE.test("_csrf")).toBe(true);
    expect(CSRF_RE.test("csrftoken")).toBe(true);
    expect(CSRF_RE.test("XSRF-TOKEN")).toBe(true);
    expect(CSRF_RE.test("_xsrf")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(CSRF_RE.test("CSRF_TOKEN")).toBe(true);
    expect(CSRF_RE.test("Ct0")).toBe(true);
    expect(CSRF_RE.test("xsrf-token")).toBe(true);
  });

  it("does not match non-CSRF cookies", () => {
    expect(CSRF_RE.test("session")).toBe(false);
    expect(CSRF_RE.test("auth_token")).toBe(false);
    expect(CSRF_RE.test("__cf_bm")).toBe(false);
    expect(CSRF_RE.test("my_csrf_token_extra")).toBe(false);
  });
});

// =====================================================================
// 6. getAuthCookies — bird-style fallback chain
// =====================================================================

describe("getAuthCookies — vault fallback", () => {
  it("returns vault cookies when available", async () => {
    const cookies = [makeCookie({ domain: ".example.com" })];
    await storeTestCredential("auth:example.com", JSON.stringify({ cookies }));

    const result = await getAuthCookies("example.com");
    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  it("returns null when no vault cookies and no browser available", async () => {
    // No vault entry for this domain, and browser extraction will fail
    // in CI/test environments (no Chrome/Firefox with cookies for this domain)
    const result = await getAuthCookies("nonexistent-domain-12345.test");
    expect(result).toBeNull();
  });
});
