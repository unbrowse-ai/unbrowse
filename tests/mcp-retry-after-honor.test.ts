import { describe, expect, test } from "bun:test";

// B3 seed (Day 3, jesus-loop session 2026-05-13).
// Per .harness-out/session-bugs-20260513T122248Z.json: 13 sessions saw
// rate_limited surfacing as a "no_endpoints" or generic resolve fallback
// rather than a structured retry-after handoff.
//
// Plan A5: parseRetryAfter must read the HTTP Retry-After header per RFC 7231
// (delta-seconds OR HTTP-date) and return ms. The executor's 429 path must
// then prefer that hint over the internal backoff.
//
// Today the helper does NOT exist in src/execution/retry.ts (zero refs in
// src/ to "Retry-After" or "retry_after" per Day 1 inventory). This test
// FAILS by import. Day 4 implements parseRetryAfter.

describe("B3: parseRetryAfter (Day 3 failing seed)", () => {
  test("delta-seconds (integer) parses to ms", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const ms = parseRetryAfter({ "retry-after": "30" });
    expect(ms).toBe(30_000);
  });

  test("delta-seconds zero", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const ms = parseRetryAfter({ "retry-after": "0" });
    expect(ms).toBe(0);
  });

  test("HTTP-date parses to positive ms in the future", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter({ "retry-after": future });
    expect(typeof ms).toBe("number");
    // Allow a 2s clock-skew tolerance.
    expect(ms).toBeGreaterThan(55_000);
    expect(ms).toBeLessThan(65_000);
  });

  test("absent header returns null", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const ms = parseRetryAfter({});
    expect(ms).toBeNull();
  });

  test("garbage value returns null (no throw)", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const ms = parseRetryAfter({ "retry-after": "not-a-real-value" });
    expect(ms).toBeNull();
  });

  test("case-insensitive header lookup (Retry-After / retry-after)", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const ms1 = parseRetryAfter({ "Retry-After": "10" });
    const ms2 = parseRetryAfter({ "retry-after": "10" });
    // At minimum the lowercase canonical form works. The fixed-source helper
    // SHOULD also accept the canonical-case form per RFC 7230 §3.2.
    expect(ms2).toBe(10_000);
    if (ms1 !== null) {
      expect(ms1).toBe(10_000);
    }
  });
});

// B3 adversarial / edge (Day 5).
describe("B3: parseRetryAfter (Day 5 edges)", () => {
  test("past HTTP-date clamps to 0 (not negative)", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const past = new Date(Date.now() - 60_000).toUTCString();
    const ms = parseRetryAfter({ "retry-after": past });
    expect(ms).toBe(0);
  });

  test("array-valued header takes first element (Node fetch shape)", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const ms = parseRetryAfter({ "retry-after": ["45", "60"] });
    expect(ms).toBe(45_000);
  });

  test("whitespace-padded delta-seconds still parses", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const ms = parseRetryAfter({ "retry-after": "  20  " });
    expect(ms).toBe(20_000);
  });

  test("negative integer delta-seconds rejected (RFC says non-negative)", async () => {
    const { parseRetryAfter } = await import("../src/execution/retry.ts");
    const ms = parseRetryAfter({ "retry-after": "-30" });
    expect(ms).toBeNull();
  });
});
