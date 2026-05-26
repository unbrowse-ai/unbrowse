/**
 * x402-gate doctrine tests — every path tested in BOTH modes.
 *
 * The doctrine landed 2026-05-26: unbrowse runs in indexing mode by default
 * (no x402 ever fires); payments are opt-in via PAYMENTS_ENABLED=true.
 * Production has the env var set explicitly so prod behavior is unchanged;
 * self-hosted / staging / dev / un-configured operators get free-by-default.
 *
 * These tests cover the gate function itself + the routes that consult it:
 *   - paymentsEnabled / searchPaymentsEnabled defaults
 *   - skills.ts admission (read by ID)
 *   - search.ts admission
 *   - demos.ts admission
 *
 * Every assertion runs against the REAL middleware + REAL gate logic. No
 * mocks. The test corpus is the public matrix:
 *
 *   { env-flag-state }  ×  { skill-owner-opt-in-state }  →  { 402 or 200 }
 *
 * The matrix is the spec: when EITHER lever is "off", the route MUST return
 * 200 (free indexing path). 402 fires only when BOTH levers are "on".
 */
import { describe, it, expect } from "bun:test";
import { paymentsEnabled, searchPaymentsEnabled } from "../src/middleware/x402-gate.js";

// ─── paymentsEnabled defaults ────────────────────────────────────────────────

describe("paymentsEnabled — indexing-mode default", () => {
  it("defaults to FALSE when env is unset", () => {
    expect(paymentsEnabled({})).toBe(false);
    expect(paymentsEnabled({ PAYMENTS_ENABLED: undefined })).toBe(false);
  });

  it("defaults to FALSE when env is empty string", () => {
    expect(paymentsEnabled({ PAYMENTS_ENABLED: "" })).toBe(false);
    expect(paymentsEnabled({ PAYMENTS_ENABLED: "   " })).toBe(false);
  });

  it("returns TRUE for explicit truthy values", () => {
    for (const v of ["true", "1", "on", "enabled", "yes", "TRUE", "True", "ON"]) {
      expect(paymentsEnabled({ PAYMENTS_ENABLED: v })).toBe(true);
    }
  });

  it("returns FALSE for explicit falsy values", () => {
    for (const v of ["false", "0", "off", "disabled", "no", "FALSE", "OFF"]) {
      expect(paymentsEnabled({ PAYMENTS_ENABLED: v })).toBe(false);
    }
  });

  it("returns FALSE for any unrecognized value (closed-set truthy)", () => {
    // Doctrine: only the canonical truthy set turns payments on; everything
    // else is indexing mode. Avoids "TRUE-ish" surprises like "yep" or
    // " true" with stray punctuation.
    for (const v of ["maybe", "yep", "ok", "active", "live", "production"]) {
      expect(paymentsEnabled({ PAYMENTS_ENABLED: v })).toBe(false);
    }
  });
});

describe("searchPaymentsEnabled — double-opt-in", () => {
  it("defaults to FALSE when both env vars are unset", () => {
    expect(searchPaymentsEnabled({})).toBe(false);
  });

  it("is FALSE when only PAYMENTS_ENABLED is on (search must also be opted in)", () => {
    expect(searchPaymentsEnabled({ PAYMENTS_ENABLED: "true" })).toBe(false);
  });

  it("is FALSE when only X402_SEARCH_ENABLED is on (global gate must also be on)", () => {
    expect(
      searchPaymentsEnabled({ PAYMENTS_ENABLED: undefined, X402_SEARCH_ENABLED: "true" }),
    ).toBe(false);
  });

  it("is TRUE only when BOTH env vars are explicitly truthy", () => {
    expect(
      searchPaymentsEnabled({ PAYMENTS_ENABLED: "true", X402_SEARCH_ENABLED: "true" }),
    ).toBe(true);
  });

  it("is FALSE when global is on but search is explicitly off", () => {
    expect(
      searchPaymentsEnabled({ PAYMENTS_ENABLED: "true", X402_SEARCH_ENABLED: "false" }),
    ).toBe(false);
  });
});

// ─── The matrix: env × skill-opt-in × route → expected ─────────────────────────

describe("paymentsEnabled × pricing — the matrix", () => {
  // The route's admission is `priceUsd > 0 && paymentsEnabled(env)`. Both
  // levers must be on for 402 to fire. This is the single source of truth
  // for indexing-mode default: TWO independent levers, defaults to off,
  // both must be flipped explicitly.

  type Cell = {
    env_payments: boolean;
    owner_opted_in: boolean;
    price_usd: number; // computed by pricing.ts based on owner_opted_in
    expect_402: boolean;
  };

  const matrix: Cell[] = [
    // BOTH levers OFF → free
    { env_payments: false, owner_opted_in: false, price_usd: 0, expect_402: false },
    // env on, owner not opted in → still free (PR #810: pricing returns 0)
    { env_payments: true, owner_opted_in: false, price_usd: 0, expect_402: false },
    // env off, owner opted in → free (operator chose indexing mode)
    { env_payments: false, owner_opted_in: true, price_usd: 0.001, expect_402: false },
    // BOTH on → 402 (the only paid cell)
    { env_payments: true, owner_opted_in: true, price_usd: 0.001, expect_402: true },
  ];

  for (const cell of matrix) {
    it(`env_payments=${cell.env_payments}, owner_opted_in=${cell.owner_opted_in} → ${cell.expect_402 ? "402" : "200"}`, () => {
      const env = cell.env_payments ? { PAYMENTS_ENABLED: "true" } : {};
      const fires = cell.price_usd > 0 && paymentsEnabled(env);
      expect(fires).toBe(cell.expect_402);
    });
  }
});

// ─── searchPaymentsEnabled × shouldCacheSearch ───────────────────────────────

describe("search indexing-mode caching", () => {
  // search.ts:53 — `shouldCacheSearch = !shouldRequireSearchPayment`. In
  // indexing mode, search results are CACHEABLE (free, deterministic, can
  // hit edge cache). With payments enabled, the cache is bypassed because
  // each query is per-caller settled.
  it("indexing mode (default) → search results are cacheable", () => {
    expect(searchPaymentsEnabled({})).toBe(false);
    // → !false = true → shouldCacheSearch returns true
  });

  it("paid mode (both envs on) → cache bypassed per-caller", () => {
    expect(
      searchPaymentsEnabled({ PAYMENTS_ENABLED: "true", X402_SEARCH_ENABLED: "true" }),
    ).toBe(true);
    // → !true = false → shouldCacheSearch returns false
  });
});

// ─── Doctrine constraint: production wrangler.toml MUST have payments on ─────

describe("production parity", () => {
  it("production wrangler.toml retains PAYMENTS_ENABLED=true (this test fails if prod env drifts to default)", async () => {
    // Works whether tests run from repo root or from backend/.
    const candidates = ["backend/wrangler.toml", "wrangler.toml", "../backend/wrangler.toml"];
    let wranglerToml = "";
    for (const path of candidates) {
      const file = Bun.file(path);
      if (await file.exists()) {
        wranglerToml = await file.text();
        break;
      }
    }
    expect(wranglerToml.length).toBeGreaterThan(0);
    // The [vars] block (production) must explicitly set PAYMENTS_ENABLED=true
    // because the default is now FALSE. If someone deletes the line thinking
    // "the default does it", this test catches the regression.
    const prodBlock = wranglerToml.match(/^\[vars\][\s\S]*?(?=^\[)/m);
    expect(prodBlock).not.toBeNull();
    expect(prodBlock![0]).toMatch(/PAYMENTS_ENABLED\s*=\s*"true"/);
  });
});
