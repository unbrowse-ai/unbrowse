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

describe("isBindingStale algebraic properties", () => {
  // Sample 50 representative `now` values across a wide range — five anchored
  // points + 45 deterministic pseudo-random values in [0, MAX_SAFE_INTEGER].
  // Deterministic to keep failures bisectable; no fast-check dependency.
  const ANCHOR_NOWS = [0, 1e6, 1e9, 1e12, Number.MAX_SAFE_INTEGER];
  function deterministicNows(): number[] {
    // Mulberry32-style PRNG seeded with a fixed constant so the suite is
    // reproducible across runs / machines.
    let state = 0x9e3779b9;
    const out: number[] = [];
    for (let i = 0; i < 45; i++) {
      state = (state + 0x6d2b79f5) | 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0,1)
      // Spread across full safe-integer range.
      out.push(Math.floor(u * Number.MAX_SAFE_INTEGER));
    }
    return out;
  }
  const SAMPLE_NOWS = [...ANCHOR_NOWS, ...deterministicNows()];

  describe("property 1: monotonicity in time", () => {
    // Once stale at t1, stale at every t2 > t1 (in time-ascending walks).
    it("for a binding with valid ttl_ms + observed_at, staleness is monotone in `now`", () => {
      // Pick a binding with a concrete, parseable observed_at.
      const observedAtMs = NOW; // 2026-01-01
      const binding = makeBinding({
        ttl_ms: ONE_HOUR_MS,
        observed_at: new Date(observedAtMs).toISOString(),
      });

      // Sort sample once so we walk strictly ascending.
      const ascending = [...SAMPLE_NOWS].sort((a, b) => a - b);
      let sawStale = false;
      for (const t of ascending) {
        const stale = isBindingStale(binding, t);
        if (sawStale) {
          // Monotonicity: once stale, always stale at any larger `now`.
          expect(stale).toBe(true);
        }
        if (stale) sawStale = true;
      }
    });

    it("monotonicity holds for a second binding with different ttl/observed", () => {
      const observedAtMs = 1_500_000_000_000; // ~2017
      const binding = makeBinding({
        ttl_ms: 5 * ONE_HOUR_MS,
        observed_at: new Date(observedAtMs).toISOString(),
      });
      const ascending = [...SAMPLE_NOWS].sort((a, b) => a - b);
      let sawStale = false;
      for (const t of ascending) {
        const stale = isBindingStale(binding, t);
        if (sawStale) expect(stale).toBe(true);
        if (stale) sawStale = true;
      }
    });

    it("monotonicity holds at the safe-integer boundary (no float overflow flip)", () => {
      // observedMs + ttl_ms is well below MAX_SAFE_INTEGER; at MAX_SAFE_INTEGER
      // it must be stale, and one ms below the deadline it must be fresh.
      const observedAtMs = NOW;
      const ttl = ONE_HOUR_MS;
      const binding = makeBinding({
        ttl_ms: ttl,
        observed_at: new Date(observedAtMs).toISOString(),
      });
      expect(isBindingStale(binding, observedAtMs + ttl)).toBe(false); // boundary
      expect(isBindingStale(binding, observedAtMs + ttl + 1)).toBe(true);
      expect(isBindingStale(binding, Number.MAX_SAFE_INTEGER)).toBe(true);
    });
  });

  describe("property 2: fresh-forever idempotence", () => {
    // No ttl_ms AND not single_use → always fresh, never throws.
    it("returns false for every sampled `now` and never throws", () => {
      const bindings: OperationBinding[] = [
        makeBinding(),
        makeBinding({ observed_at: new Date(NOW).toISOString() }),
        makeBinding({ observed_at: new Date(0).toISOString() }),
        // single_use:false explicitly + no ttl.
        makeBinding({ single_use: false }),
        // ttl_ms unset + observed_at unparseable → still fresh (no throw).
        makeBinding({ observed_at: "garbage" }),
      ];
      for (const b of bindings) {
        for (const t of SAMPLE_NOWS) {
          let stale: boolean | undefined;
          expect(() => {
            stale = isBindingStale(b, t);
          }).not.toThrow();
          expect(stale).toBe(false);
        }
      }
    });

    it("returns false even when usage:{consumed:false} is passed (no single_use)", () => {
      const binding = makeBinding({ observed_at: new Date(NOW).toISOString() });
      for (const t of SAMPLE_NOWS) {
        expect(isBindingStale(binding, t, { consumed: false })).toBe(false);
      }
    });

    it("returns false even when usage:{consumed:true} is passed if single_use unset", () => {
      // single_use is NOT true → consumed has no effect.
      const binding = makeBinding({ observed_at: new Date(NOW).toISOString() });
      for (const t of SAMPLE_NOWS) {
        expect(isBindingStale(binding, t, { consumed: true })).toBe(false);
      }
    });
  });

  describe("property 3: single-use lattice (consumption dominates ttl)", () => {
    // single_use:true + consumed:true → stale regardless of ttl_ms / observed_at.
    it("consumed:true returns true even when ttl window is far in the future", () => {
      // Make ttl_ms huge and observed_at = now, so TTL alone would say fresh.
      const binding = makeBinding({
        single_use: true,
        ttl_ms: 100 * 365 * 24 * 3_600_000, // 100 years
        observed_at: new Date(NOW).toISOString(),
      });
      for (const t of SAMPLE_NOWS) {
        expect(isBindingStale(binding, t, { consumed: true })).toBe(true);
      }
    });

    it("consumed:true returns true even when binding has no ttl/observed at all", () => {
      const binding = makeBinding({ single_use: true });
      for (const t of SAMPLE_NOWS) {
        expect(isBindingStale(binding, t, { consumed: true })).toBe(true);
      }
    });

    it("consumed:false follows the TTL rule (fresh while in window, stale past it)", () => {
      const observedAtMs = NOW;
      const ttl = ONE_HOUR_MS;
      const binding = makeBinding({
        single_use: true,
        ttl_ms: ttl,
        observed_at: new Date(observedAtMs).toISOString(),
      });
      // Inside the window → fresh.
      expect(isBindingStale(binding, observedAtMs, { consumed: false })).toBe(false);
      expect(isBindingStale(binding, observedAtMs + ttl - 1, { consumed: false })).toBe(false);
      // At the boundary → fresh (strict less-than).
      expect(isBindingStale(binding, observedAtMs + ttl, { consumed: false })).toBe(false);
      // Past the boundary → stale.
      expect(isBindingStale(binding, observedAtMs + ttl + 1, { consumed: false })).toBe(true);
    });

    it("consumed:false with no ttl is fresh forever (lattice bottom)", () => {
      const binding = makeBinding({ single_use: true });
      for (const t of SAMPLE_NOWS) {
        expect(isBindingStale(binding, t, { consumed: false })).toBe(false);
      }
    });
  });

  describe("property 4: boundary precision (strict less-than at the edge)", () => {
    it("observed_at + ttl_ms === now is fresh; +1 ms is stale", () => {
      const observedAtMs = NOW;
      const ttl = ONE_HOUR_MS;
      const binding = makeBinding({
        ttl_ms: ttl,
        observed_at: new Date(observedAtMs).toISOString(),
      });
      // Exact boundary: deadline equals now → fresh (strict <).
      expect(isBindingStale(binding, observedAtMs + ttl)).toBe(false);
      // One ms past: stale.
      expect(isBindingStale(binding, observedAtMs + ttl + 1)).toBe(true);
      // One ms before: fresh.
      expect(isBindingStale(binding, observedAtMs + ttl - 1)).toBe(false);
    });

    it("boundary holds with ttl_ms=0 + observed_at parseable (degenerate edge)", () => {
      const observedAtMs = NOW;
      const binding = makeBinding({
        ttl_ms: 0,
        observed_at: new Date(observedAtMs).toISOString(),
      });
      // deadline = observedAtMs; at exact now → fresh; one ms past → stale.
      expect(isBindingStale(binding, observedAtMs)).toBe(false);
      expect(isBindingStale(binding, observedAtMs + 1)).toBe(true);
    });

    it("boundary holds at observed_at=epoch 0 + small ttl", () => {
      const binding = makeBinding({
        ttl_ms: 1000,
        observed_at: new Date(0).toISOString(),
      });
      expect(isBindingStale(binding, 1000)).toBe(false); // exact boundary
      expect(isBindingStale(binding, 1001)).toBe(true);
      expect(isBindingStale(binding, 999)).toBe(false);
    });
  });
});
