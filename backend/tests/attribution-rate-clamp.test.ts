// The funnel "2200%" fix: a conversion rate is bounded [0,1]; rate() clamps the
// upper end so active>installs (mismatched populations) can't blow past 100%.
import { describe, it, expect } from "bun:test";
import { rate } from "../src/services/attribution-link.js";

describe("attribution rate() clamp (funnel 2200% fix)", () => {
  it("clamps a ratio above 1 to 1 (the active>installs case → was 2200%)", () => {
    expect(rate(22, 1)).toBe(1); // 22 active / 1 install → 100%, not 2200%
    expect(rate(5, 2)).toBe(1);
  });

  it("computes honest sub-1 rates normally", () => {
    expect(rate(1, 2)).toBe(0.5);
    expect(rate(3, 4)).toBe(0.75);
    expect(rate(1, 1)).toBe(1);
  });

  it("returns 0 for a zero/empty denominator (no division by zero)", () => {
    expect(rate(0, 0)).toBe(0);
    expect(rate(5, 0)).toBe(0);
  });

  it("rounds to 3 decimals", () => {
    expect(rate(1, 3)).toBe(0.333);
  });
});
