/**
 * fair-compensation.test — the native 20%-on-tx-costs engine. Proves: the default rate is 20%,
 * the env override is honored + clamped (garbage falls back, never throws), USD markup is exact,
 * the µUSDC path is integer + rounds compensation UP (platform never shorted), and the recipient
 * resolves from PAYMENT_RECIPIENT.
 */
import { describe, expect, it } from "bun:test";
import {
  FAIR_COMPENSATION_BPS,
  fairCompensationBps,
  compensateTxCost,
  compensateTxCostUc,
  fairCompensationRecipient,
} from "../src/services/fair-compensation.js";

describe("fairCompensationBps", () => {
  it("defaults to 20% (2000 bps)", () => {
    expect(FAIR_COMPENSATION_BPS).toBe(2000);
    expect(fairCompensationBps()).toBe(2000);
    expect(fairCompensationBps({})).toBe(2000);
  });
  it("honors a valid env override (string or number)", () => {
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: "3000" })).toBe(3000);
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: 500 })).toBe(500);
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: 0 })).toBe(0);
  });
  it("falls back to default on garbage / out-of-range (never throws)", () => {
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: "abc" })).toBe(2000);
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: -1 })).toBe(2000);
    expect(fairCompensationBps({ FAIR_COMPENSATION_BPS: 10001 })).toBe(2000);
  });
});

describe("compensateTxCost (USD)", () => {
  it("adds 20% on top of the upstream cost", () => {
    const r = compensateTxCost(0.01);
    expect(r.upstreamUsd).toBe(0.01);
    expect(r.compensationUsd).toBeCloseTo(0.002, 10);
    expect(r.totalUsd).toBeCloseTo(0.012, 10);
    expect(r.bps).toBe(2000);
  });
  it("honors the override rate", () => {
    expect(compensateTxCost(1, { FAIR_COMPENSATION_BPS: 5000 }).totalUsd).toBeCloseTo(1.5, 10);
  });
  it("clamps a negative / NaN upstream to zero", () => {
    expect(compensateTxCost(-5).totalUsd).toBe(0);
    expect(compensateTxCost(Number.NaN).totalUsd).toBe(0);
  });
});

describe("compensateTxCostUc (µUSDC, on-chain)", () => {
  it("computes integer µUSDC with 20% markup", () => {
    const r = compensateTxCostUc(10_000n); // $0.01 in µUSDC
    expect(r.upstreamUc).toBe(10_000n);
    expect(r.compensationUc).toBe(2_000n); // 20%
    expect(r.totalUc).toBe(12_000n);
  });
  it("rounds compensation UP so the platform is never shorted by sub-µ", () => {
    // 1 µUSDC * 2000 / 10000 = 0.2 → ceil → 1 µUSDC
    expect(compensateTxCostUc(1n).compensationUc).toBe(1n);
    // 3 µUSDC * 2000 / 10000 = 0.6 → ceil → 1
    expect(compensateTxCostUc(3n).compensationUc).toBe(1n);
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
