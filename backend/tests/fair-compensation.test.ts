/**
 * fair-compensation.test — the native take-rate engine. Proves the OPT-IN posture: the default
 * rate is 0% (execution is FREE — unbrowse takes no cut on the commons; a fronted paid upstream
 * is passed through at raw cost), the opt-in markup is honored + clamped (garbage falls back,
 * never throws), the USD + µUSDC markup math is exact WHEN a rate is opted in, and the recipient
 * resolves from PAYMENT_RECIPIENT. Monetization lives at the owner-priced Flex/x402 edge, not here.
 */
import { describe, expect, it } from "bun:test";
import {
  FAIR_COMPENSATION_BPS,
  fairCompensationBps,
  compensateTxCost,
  compensateTxCostUc,
  fairCompensationRecipient,
} from "../src/services/fair-compensation.js";

// An opted-in deployment that re-enables a 20% broker markup (the historical default).
const OPTED_IN_20 = { FAIR_COMPENSATION_BPS: 2000 } as const;

describe("fairCompensationBps", () => {
  it("defaults to 0% — execution is free (no cut on the commons)", () => {
    expect(FAIR_COMPENSATION_BPS).toBe(0);
    expect(fairCompensationBps()).toBe(0);
    expect(fairCompensationBps({})).toBe(0);
  });
  it("honors an opted-in env override (string or number)", () => {
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: "3000" })).toBe(3000);
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: 500 })).toBe(500);
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: 2000 })).toBe(2000);
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: 0 })).toBe(0);
  });
  it("falls back to the (free) default on garbage / out-of-range (never throws)", () => {
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: "abc" })).toBe(0);
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: -1 })).toBe(0);
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: 10001 })).toBe(0);
  });
});

describe("compensateTxCost (USD)", () => {
  it("default: passes a fronted upstream through at raw cost — no markup", () => {
    const r = compensateTxCost(0.01);
    expect(r.upstreamUsd).toBe(0.01);
    expect(r.compensationUsd).toBe(0);
    expect(r.totalUsd).toBeCloseTo(0.01, 10);
    expect(r.bps).toBe(0);
  });
  it("adds the opted-in markup on top of the upstream cost", () => {
    const r = compensateTxCost(0.01, OPTED_IN_20);
    expect(r.upstreamUsd).toBe(0.01);
    expect(r.compensationUsd).toBeCloseTo(0.002, 10);
    expect(r.totalUsd).toBeCloseTo(0.012, 10);
    expect(r.bps).toBe(2000);
  });
  it("honors an arbitrary override rate", () => {
    expect(compensateTxCost(1, { FAIR_COMPENSATION_BPS: 5000 }).totalUsd).toBeCloseTo(1.5, 10);
  });
  it("clamps a negative / NaN upstream to zero", () => {
    expect(compensateTxCost(-5).totalUsd).toBe(0);
    expect(compensateTxCost(Number.NaN).totalUsd).toBe(0);
  });
});

describe("compensateTxCostUc (µUSDC, on-chain)", () => {
  it("default: integer pass-through at cost — no markup", () => {
    const r = compensateTxCostUc(10_000n); // $0.01 in µUSDC
    expect(r.upstreamUc).toBe(10_000n);
    expect(r.compensationUc).toBe(0n);
    expect(r.totalUc).toBe(10_000n);
  });
  it("computes integer µUSDC with the opted-in 20% markup", () => {
    const r = compensateTxCostUc(10_000n, OPTED_IN_20);
    expect(r.upstreamUc).toBe(10_000n);
    expect(r.compensationUc).toBe(2_000n); // 20%
    expect(r.totalUc).toBe(12_000n);
  });
  it("rounds an opted-in compensation UP so the platform is never shorted by sub-µ", () => {
    // 1 µUSDC * 2000 / 10000 = 0.2 → ceil → 1 µUSDC
    expect(compensateTxCostUc(1n, OPTED_IN_20).compensationUc).toBe(1n);
    // 3 µUSDC * 2000 / 10000 = 0.6 → ceil → 1
    expect(compensateTxCostUc(3n, OPTED_IN_20).compensationUc).toBe(1n);
  });
  it("zero / negative upstream → zero compensation", () => {
    expect(compensateTxCostUc(0n).totalUc).toBe(0n);
    expect(compensateTxCostUc(-9n).compensationUc).toBe(0n);
  });
});

describe("fairCompensationRecipient", () => {
  it("resolves the platform wallet from PAYMENT_RECIPIENT, undefined when unset", () => {
    expect(fairCompensationRecipient({ PAYMENT_RECIPIENT: " PlatformAtaXyz " })).toBe("PlatformAtaXyz");
    expect(fairCompensationRecipient({ PAYMENT_RECIPIENT: "" })).toBeUndefined();
    expect(fairCompensationRecipient()).toBeUndefined();
  });
});
