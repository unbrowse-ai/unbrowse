/**
 * Wave 6 unit tests for the per-skill markup_bps override on
 * computeFlexSplits in backend/src/services/flex.ts.
 *
 * Per CLAUDE.md "Never mock in tests" — these hit the real
 * computeFlexSplits + assert on the resulting splits array. No backend
 * boot, no facilitator HTTP, no Solana RPC.
 *
 * Pontus / ABK Labs 2026-05-21: "5-80% markup potential on Flex".
 * The clamp range [MARKUP_BPS_MIN=500, MARKUP_BPS_MAX=8000] enforces
 * this; the default PLATFORM_BPS=5000 (50%) sits inside that range.
 */
import { describe, it, expect } from "bun:test";
import { computeFlexSplits, PLATFORM_BPS, MARKUP_BPS_MIN, MARKUP_BPS_MAX } from "../src/services/flex.js";

const PLATFORM = "platform-usdc-ata";
const CONTRIB_A = "contributor-a-usdc-ata";

describe("computeFlexSplits + markup_bps (Wave 6)", () => {
  it("defaults to PLATFORM_BPS=5000 when markup_bps is unset", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }] } as any,
      PLATFORM,
    );
    expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(PLATFORM_BPS);
  });

  it("honors a custom markup_bps inside the [500, 8000] range", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }], markup_bps: 2500 } as any,
      PLATFORM,
    );
    expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(2500);
  });

  it("honors the 80% upper bound (markup_bps=8000)", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }], markup_bps: 8000 } as any,
      PLATFORM,
    );
    expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(8000);
  });

  it("clamps markup_bps > MARKUP_BPS_MAX down to 8000", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }], markup_bps: 9500 } as any,
      PLATFORM,
    );
    expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(MARKUP_BPS_MAX);
  });

  it("clamps markup_bps < MARKUP_BPS_MIN up to 500", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }], markup_bps: 100 } as any,
      PLATFORM,
    );
    expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(MARKUP_BPS_MIN);
  });

  it("falls back to PLATFORM_BPS for non-finite markup_bps (NaN)", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }], markup_bps: NaN } as any,
      PLATFORM,
    );
    expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(PLATFORM_BPS);
  });

  it("falls back to PLATFORM_BPS for negative markup_bps", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }], markup_bps: -100 } as any,
      PLATFORM,
    );
    expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(PLATFORM_BPS);
  });

  it("rounds fractional markup_bps to nearest integer", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }], markup_bps: 2500.7 } as any,
      PLATFORM,
    );
    expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(2501);
  });

  it("total bps sum to exactly 10000 with custom markup_bps", () => {
    const splits = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }], markup_bps: 7500 } as any,
      PLATFORM,
    );
    const total = splits.reduce((s, x) => s + x.bps, 0);
    expect(total).toBe(10000);
  });

  it("indexer pool shrinks when markup_bps is raised (50% -> 75%)", () => {
    const at50 = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }] } as any,
      PLATFORM,
    );
    const at75 = computeFlexSplits(
      { contributors: [{ wallet_address: CONTRIB_A, cumulative_delta: 1 }], markup_bps: 7500 } as any,
      PLATFORM,
    );
    const contrib50 = at50.find((s) => s.recipient === CONTRIB_A)?.bps ?? 0;
    const contrib75 = at75.find((s) => s.recipient === CONTRIB_A)?.bps ?? 0;
    expect(contrib50).toBe(5000); // 10000 - 5000 platform
    expect(contrib75).toBe(2500); // 10000 - 7500 platform
  });
});
