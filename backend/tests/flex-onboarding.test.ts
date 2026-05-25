import { describe, test, expect } from "bun:test";
import { checkFlexOnboarding, buildFlexOnboardingRequired402 } from "../src/middleware/flex-onboarding-required.js";
import { computeFlexSplits, PLATFORM_BPS } from "../src/services/flex.js";

describe("flex-onboarding — Day 3 seeds", () => {
  test("checkFlexOnboarding flags all three missing on empty profile", () => {
    const r = checkFlexOnboarding({});
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(["wallet_address", "flex_escrow_address", "flex_session_key_address"]);
  });
  test("checkFlexOnboarding is ready when all three present", () => {
    const r = checkFlexOnboarding({
      wallet_address: "Wallet1",
      flex_escrow_address: "Escrow1",
      flex_session_key_address: "SessKey1",
    });
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });
  test("buildFlexOnboardingRequired402 shape", () => {
    const resp = buildFlexOnboardingRequired402(["flex_escrow_address"]);
    expect(resp.status).toBe(402);
    expect(resp.headers["X-Flex-Onboarding-Required"]).toBe("1");
    expect(resp.body.error).toBe("flex_onboarding_incomplete");
  });
});

describe("flex-splits — Day 3 seeds", () => {
  test("computeFlexSplits returns empty array for no payable contributors", () => {
    const splits = computeFlexSplits({ contributors: [] }, "PlatformATA");
    expect(splits).toEqual([]);
  });
  test("computeFlexSplits single contributor: platform half + contributor half = 10000 bps", () => {
    const splits = computeFlexSplits(
      { contributors: [{ agent_id: "a1", wallet_address: "W1", cumulative_delta: 1.0 } as any] },
      "PlatformATA",
    );
    expect(splits.length).toBe(2);
    const sum = splits.reduce((s, e) => s + e.bps, 0);
    expect(sum).toBe(10000);
    expect(splits[0].recipient).toBe("PlatformATA");
    expect(splits[0].bps).toBe(PLATFORM_BPS);
    expect(splits[1].bps).toBe(10000 - PLATFORM_BPS);
  });
  test("computeFlexSplits caps at 5 entries (platform + 4 contributors)", () => {
    const contributors = Array.from({ length: 10 }, (_, i) => ({
      agent_id: `a${i}`,
      wallet_address: `W${i}`,
      cumulative_delta: 1.0,
    } as any));
    const splits = computeFlexSplits({ contributors }, "PlatformATA");
    expect(splits.length).toBe(5);
    const sum = splits.reduce((s, e) => s + e.bps, 0);
    expect(sum).toBe(10000);
  });
});
