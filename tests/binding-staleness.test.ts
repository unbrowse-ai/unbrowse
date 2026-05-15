/**
 * Layer B unit tests — pure helpers for OperationBinding freshness.
 *
 * No I/O, no clock, no mocks. Every test passes a synthetic `now` so the
 * helpers can be reasoned about deterministically. See
 * `.claude/jesus-loop.default.architecture.md` AC4.
 */

import { describe, expect, it } from "bun:test";
import {
  isBindingStale,
  parseMaxAge,
  parseExpiresIn,
  isCsrfShapedKey,
} from "../src/orchestrator/dag-feedback.js";
import type { OperationBinding } from "../src/types/index.js";

// A pinned, easy-to-eyeball epoch ms. 2026-01-01T00:00:00.000Z.
const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const ONE_HOUR_MS = 3_600_000;

function makeBinding(over: Partial<OperationBinding> = {}): OperationBinding {
  return { key: "test", ...over };
}

describe("isBindingStale", () => {
  it("returns false when binding has no ttl_ms and no single_use (fresh forever)", () => {
    expect(isBindingStale(makeBinding(), NOW)).toBe(false);
    expect(isBindingStale(makeBinding({ observed_at: new Date(NOW).toISOString() }), NOW)).toBe(false);
  });

  it("returns false at the exact boundary (observed_at + ttl_ms === now, strictly less-than)", () => {
    const observed = new Date(NOW - ONE_HOUR_MS).toISOString();
    const binding = makeBinding({ ttl_ms: ONE_HOUR_MS, observed_at: observed });
    // observed + ttl === now → fresh per spec.
    expect(isBindingStale(binding, NOW)).toBe(false);
  });

  it("returns false within the ttl window (observed_at + ttl_ms > now)", () => {
    const observed = new Date(NOW - ONE_HOUR_MS / 2).toISOString();
    const binding = makeBinding({ ttl_ms: ONE_HOUR_MS, observed_at: observed });
    expect(isBindingStale(binding, NOW)).toBe(false);
  });

  it("returns true just past the ttl window (observed_at + ttl_ms < now)", () => {
    const observed = new Date(NOW - ONE_HOUR_MS - 1).toISOString();
    const binding = makeBinding({ ttl_ms: ONE_HOUR_MS, observed_at: observed });
    expect(isBindingStale(binding, NOW)).toBe(true);
  });

  it("returns false when single_use:true but usage.consumed:false", () => {
    const binding = makeBinding({ single_use: true });
    expect(isBindingStale(binding, NOW, { consumed: false })).toBe(false);
  });

  it("returns true when single_use:true and usage.consumed:true", () => {
    const binding = makeBinding({ single_use: true });
    expect(isBindingStale(binding, NOW, { consumed: true })).toBe(true);
  });

  it("returns false when single_use:true and usage is undefined (not-yet-consumed)", () => {
    const binding = makeBinding({ single_use: true });
    expect(isBindingStale(binding, NOW)).toBe(false);
    expect(isBindingStale(binding, NOW, undefined)).toBe(false);
    // Also: usage object present but consumed undefined.
    expect(isBindingStale(binding, NOW, {})).toBe(false);
  });

  it("returns true when BOTH stale-ttl AND single-use-consumed (any-of semantics)", () => {
    const observed = new Date(NOW - ONE_HOUR_MS - 1).toISOString();
    const binding = makeBinding({
      ttl_ms: ONE_HOUR_MS,
      observed_at: observed,
      single_use: true,
    });
    expect(isBindingStale(binding, NOW, { consumed: true })).toBe(true);
  });

  it("returns false when ttl_ms:0 but single_use unset and no usage (degenerate, well-defined)", () => {
    // ttl_ms:0 with no observed_at → ttl branch not taken (requires both).
    // single_use unset → consumed branch not taken.
    // Hence: fresh.
    const binding = makeBinding({ ttl_ms: 0 });
    expect(isBindingStale(binding, NOW)).toBe(false);
  });

  it("returns false when observed_at is unparseable (graceful, no throw)", () => {
    const binding = makeBinding({ ttl_ms: ONE_HOUR_MS, observed_at: "garbage" });
    expect(() => isBindingStale(binding, NOW)).not.toThrow();
    expect(isBindingStale(binding, NOW)).toBe(false);
  });
});

describe("parseMaxAge", () => {
  it("'sessionid=abc; Max-Age=3600; Path=/' returns 3_600_000 with any now", () => {
    expect(parseMaxAge("sessionid=abc; Max-Age=3600; Path=/", 0)).toBe(3_600_000);
    expect(parseMaxAge("sessionid=abc; Max-Age=3600; Path=/", NOW)).toBe(3_600_000);
    expect(parseMaxAge("sessionid=abc; Max-Age=3600; Path=/", Number.MAX_SAFE_INTEGER)).toBe(3_600_000);
  });

  it("'sessionid=abc; Max-Age=0; Path=/' returns 0 (expired now)", () => {
    expect(parseMaxAge("sessionid=abc; Max-Age=0; Path=/", NOW)).toBe(0);
  });

  it("'sessionid=abc; Expires=...' returns Math.max(0, expires - now)", () => {
    const header = "sessionid=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT";
    const expiresMs = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
    const beforeNow = expiresMs - 60_000;
    const afterNow = expiresMs + 60_000;

    expect(parseMaxAge(header, beforeNow)).toBe(60_000);
    expect(parseMaxAge(header, afterNow)).toBe(0); // clamped to 0
    expect(parseMaxAge(header, expiresMs)).toBe(0); // exactly at boundary
  });

  it("Max-Age wins when both Max-Age and Expires are present (RFC 6265)", () => {
    const header = "sessionid=abc; Max-Age=3600; Expires=Wed, 21 Oct 2026 07:28:00 GMT";
    expect(parseMaxAge(header, NOW)).toBe(3_600_000);
  });

  it("'sessionid=abc; Path=/' (no max-age, no expires) returns undefined", () => {
    expect(parseMaxAge("sessionid=abc; Path=/", NOW)).toBeUndefined();
  });

  it("'sessionid=abc; Max-Age=NaN' returns undefined (unparseable)", () => {
    expect(parseMaxAge("sessionid=abc; Max-Age=NaN", NOW)).toBeUndefined();
  });
});

describe("parseExpiresIn", () => {
  it("{ access_token: 'x', expires_in: 3600 } returns 3_600_000", () => {
    expect(parseExpiresIn({ access_token: "x", expires_in: 3600 })).toBe(3_600_000);
  });

  it("{ expires_in: '3600' } returns undefined (must be a number)", () => {
    expect(parseExpiresIn({ expires_in: "3600" })).toBeUndefined();
  });

  it("{ expires_in: 0 } returns 0", () => {
    expect(parseExpiresIn({ expires_in: 0 })).toBe(0);
  });

  it("{ expires_in: -1 } returns undefined (non-negative only)", () => {
    expect(parseExpiresIn({ expires_in: -1 })).toBeUndefined();
  });

  it("{} returns undefined (missing field)", () => {
    expect(parseExpiresIn({})).toBeUndefined();
  });

  it("non-object inputs return undefined (null, undefined, string, array)", () => {
    expect(parseExpiresIn(null)).toBeUndefined();
    expect(parseExpiresIn(undefined)).toBeUndefined();
    expect(parseExpiresIn("string")).toBeUndefined();
    expect(parseExpiresIn([1, 2, 3])).toBeUndefined();
  });
});

describe("isCsrfShapedKey", () => {
  it("matches csrf-shaped keys", () => {
    expect(isCsrfShapedKey("csrf")).toBe(true);
    expect(isCsrfShapedKey("csrf_token")).toBe(true);
    expect(isCsrfShapedKey("_csrf")).toBe(true);
    expect(isCsrfShapedKey("CSRF-TOKEN")).toBe(true);
  });

  it("matches xsrf-shaped keys", () => {
    expect(isCsrfShapedKey("xsrf")).toBe(true);
    expect(isCsrfShapedKey("x-xsrf-token")).toBe(true);
  });

  it("matches generic token keys (token, no auth/access/refresh)", () => {
    expect(isCsrfShapedKey("api_token")).toBe(true);
  });

  it("rejects auth-shaped token keys", () => {
    expect(isCsrfShapedKey("access_token")).toBe(false);
    expect(isCsrfShapedKey("refresh_token")).toBe(false);
    expect(isCsrfShapedKey("auth_token")).toBe(false);
  });

  it("rejects unrelated keys", () => {
    expect(isCsrfShapedKey("session_id")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isCsrfShapedKey("")).toBe(false);
  });
});
