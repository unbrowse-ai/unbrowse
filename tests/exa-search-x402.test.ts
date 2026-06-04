// Search-on-top payment split — the priced /v1/search call (route graph + paid
// web-search fallback) settles via x402 and splits the fee 50/35/15 across
// platform / indexer / owner. The on-chain settlement is the backend's job;
// here we guard the CLIENT-VISIBLE breakdown the CLI/SDK shows in a receipt.
import { test, expect } from "bun:test";
import { SPLIT_BPS, BPS_TOTAL, computeSplit } from "../src/payments/split-constants.js";

test("split is 50/35/15 and sums to 100%", () => {
  expect(SPLIT_BPS.platform).toBe(5000); // 50%
  expect(SPLIT_BPS.indexer).toBe(3500); // 35%
  expect(SPLIT_BPS.owner).toBe(1500); // 15%
  expect(SPLIT_BPS.platform + SPLIT_BPS.indexer + SPLIT_BPS.owner).toBe(BPS_TOTAL);
});

test("computeSplit divides an Exa $0.007 fee (7000 atomic) by 50/35/15", () => {
  const parts = computeSplit(7000);
  const byParty = Object.fromEntries(parts.map((p) => [p.party, p.amount]));
  expect(byParty.platform).toBe(3500);
  expect(byParty.indexer).toBe(2450);
  expect(byParty.owner).toBe(1050);
  expect(parts.reduce((s, p) => s + p.amount, 0)).toBe(7000); // exact, no drift
});

test("computeSplit never drifts on awkward fees", () => {
  for (const fee of [1, 3, 7, 101, 9999, 10001, 12345]) {
    const parts = computeSplit(fee);
    expect(parts.reduce((s, p) => s + p.amount, 0)).toBe(fee);
  }
});

test("computeSplit rejects negative fees", () => {
  expect(() => computeSplit(-1)).toThrow();
});
