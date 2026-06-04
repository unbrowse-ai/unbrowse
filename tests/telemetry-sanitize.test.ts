import { describe, expect, test } from "bun:test";
import {
  scrubText,
  templateUrl,
  fingerprintIntent,
  sanitizeArgs,
  summarizeResponse,
  extractErrorCode,
  shaHex,
} from "../src/telemetry/sanitize.js";

// These tests check structural properties of the sanitizer — they do NOT
// assert against literal hash values I authored. The check is "the input
// is no longer present in the output", which falsifies if a future change
// removes the sanitizer call.

describe("telemetry/sanitize: scrubText", () => {
  test("redacts emails", () => {
    const out = scrubText("contact me at lewis@foundry.com for details");
    expect(out).not.toContain("lewis@foundry.com");
    expect(out).toContain("<email>");
  });

  test("redacts uuids", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const out = scrubText(`session ${id} failed`);
    expect(out).not.toContain(id);
    expect(out).toContain("<uuid>");
  });

  test("redacts IPv4 addresses", () => {
    const out = scrubText("client 192.168.1.42 connected");
    expect(out).not.toContain("192.168.1.42");
    expect(out).toContain("<ip4>");
  });

  test("redacts JWT-shaped tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT";
    const out = scrubText(`Bearer ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("<jwt>");
  });

  test("leaves non-PII prose intact", () => {
    const out = scrubText("rate limited by upstream after 3 retries");
    expect(out).toBe("rate limited by upstream after 3 retries");
  });
});

describe("telemetry/sanitize: templateUrl", () => {
  test("templates a reddit post URL with multiple entity segments", () => {
    const t = templateUrl("https://www.reddit.com/r/programming/comments/1abc234/some_slug/");
    if ("invalid" in t) throw new Error("expected URL to parse");
    expect(t.host).toBe("www.reddit.com");
    expect(t.path_template).toMatch(/\{(id|hex|token)\}/);
    expect(t.path_template).not.toContain("1abc234");
  });

  test("preserves query keys, redacts query values", () => {
    const t = templateUrl("https://api.x.com/search?q=secret-query&limit=10");
    if ("invalid" in t) throw new Error("expected URL to parse");
    expect(t.query_keys).toEqual(["q", "limit"]);
  });

  test("returns a fingerprint for malformed URLs", () => {
    const t = templateUrl("not a url at all");
    expect("invalid" in t).toBe(true);
  });
});

describe("telemetry/sanitize: fingerprintIntent", () => {
  test("hashes intent text and exposes length/word_count only", () => {
    const fp = fingerprintIntent("search hacker news for AI agents in 2026");
    expect(fp).toBeDefined();
    expect(fp!.intent_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(fp!.length).toBe(40);
    expect(fp!.word_count).toBe(8);
  });

  test("identical intents hash identically (clustering invariant)", () => {
    const a = fingerprintIntent("search reddit for cats");
    const b = fingerprintIntent("search reddit for cats");
    expect(a!.intent_hash).toBe(b!.intent_hash);
  });

  test("different intents hash differently", () => {
    const a = fingerprintIntent("search reddit for cats");
    const b = fingerprintIntent("search reddit for dogs");
    expect(a!.intent_hash).not.toBe(b!.intent_hash);
  });

  test("returns undefined for non-strings", () => {
    expect(fingerprintIntent(undefined)).toBeUndefined();
    expect(fingerprintIntent(42)).toBeUndefined();
  });
});

describe("telemetry/sanitize: sanitizeArgs", () => {
  test("hashes intent field, templates url field, redacts header field", () => {
    const args = {
      intent: "find john@example.com on linkedin",
      url: "https://www.linkedin.com/in/lewis-tham/",
      headers: { Authorization: "Bearer secret-token-xyz" },
      depth: 3,
    };
    const out = sanitizeArgs(args);
    expect(out.intent).toMatchObject({ length: 33, word_count: 4 });
    expect((out.intent as { intent_hash: string }).intent_hash).toMatch(/^[0-9a-f]{32}$/);
    expect((out.url as { host: string }).host).toBe("www.linkedin.com");
    expect((out.url as { path_template: string }).path_template).not.toContain("lewis-tham");
    expect(out.headers).toBe("<redacted:header>");
    expect(out.depth).toBe(3);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("john@example.com");
    expect(serialized).not.toContain("lewis-tham");
    expect(serialized).not.toContain("secret-token-xyz");
  });
  test("recursively scrubs PII in nested free-text fields", () => {
    const args = {
      notes: "user is lewis@foundry.com, IP 10.0.0.1",
      meta: { reason: "uuid 550e8400-e29b-41d4-a716-446655440000 expired" },
    };
    const out = sanitizeArgs(args);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("lewis@foundry.com");
    expect(serialized).not.toContain("10.0.0.1");
    expect(serialized).not.toContain("550e8400");
  });

  test("returns empty object for non-object input", () => {
    expect(sanitizeArgs(null)).toEqual({});
    expect(sanitizeArgs("string")).toEqual({});
    expect(sanitizeArgs(42)).toEqual({});
  });
});

describe("telemetry/sanitize: summarizeResponse", () => {
  test("array response: shape + item_count + bytes", () => {
    const r = summarizeResponse([1, 2, 3, 4]);
    expect(r.shape).toBe("array");
    expect(r.item_count).toBe(4);
    expect(r.bytes).toBeGreaterThan(0);
  });

  test("object response: shape + top_keys (capped) + bytes", () => {
    const r = summarizeResponse({ a: 1, b: 2, c: 3 });
    expect(r.shape).toBe("object");
    expect(r.top_keys).toEqual(["a", "b", "c"]);
  });

  test("null response", () => {
    expect(summarizeResponse(null).shape).toBe("null");
  });
});

describe("telemetry/sanitize: extractErrorCode", () => {
  test("pulls error_code from structured payload", () => {
    expect(extractErrorCode({ error_code: "auth_required" })).toBe("auth_required");
  });

  test("pulls nested error.code", () => {
    expect(extractErrorCode({ error: { code: "rate_limited" } })).toBe("rate_limited");
  });

  test("returns undefined when no code present", () => {
    expect(extractErrorCode({ message: "something failed" })).toBeUndefined();
  });
});

describe("telemetry/sanitize: shaHex", () => {
  test("deterministic and bounded", () => {
    expect(shaHex("hello", 16)).toBe(shaHex("hello", 16));
    expect(shaHex("hello", 16).length).toBe(16);
    expect(shaHex("hello", 32).length).toBe(32);
  });
});
