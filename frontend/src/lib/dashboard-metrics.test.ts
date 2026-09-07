// Network-impact panel pure logic: compact formatting, honest your-share ratio, bar clamp.
import { describe, it, expect } from "bun:test";
import { formatCompact, networkSharePct, shareBarWidth } from "./dashboard-metrics";

describe("formatCompact", () => {
  it("formats millions / thousands / small", () => {
    expect(formatCompact(3_120_000)).toBe("3.1M");
    expect(formatCompact(12_480_000)).toBe("12M");
    expect(formatCompact(3_120)).toBe("3.1k");
    expect(formatCompact(12_480)).toBe("12k");
    expect(formatCompact(842)).toBe("842");
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(undefined)).toBe("0");
  });
});

describe("networkSharePct", () => {
  it("honest ratio of two real counts", () => {
    expect(networkSharePct(412, 12_480)).toBeCloseTo(3.3013, 3);
    expect(networkSharePct(1, 1)).toBe(100);
  });
  it("0 when the network has no executions (no division by zero)", () => {
    expect(networkSharePct(5, 0)).toBe(0);
    expect(networkSharePct(0, 0)).toBe(0);
  });
});

describe("shareBarWidth", () => {
  it("floors a non-zero share at 1.5% so it stays visible", () => {
    expect(shareBarWidth(0.3)).toBe(1.5);
    expect(shareBarWidth(3.3)).toBe(3.3);
  });
  it("zero stays zero; never exceeds 100", () => {
    expect(shareBarWidth(0)).toBe(0);
    expect(shareBarWidth(250)).toBe(100);
  });
});
