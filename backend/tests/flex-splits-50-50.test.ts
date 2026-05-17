import { describe, expect, it } from "bun:test";
import {
  PLATFORM_BPS,
  FLEX_MAX_SPLITS,
  computeFlexSplits,
  mergeSplits,
} from "../src/services/flex.js";
import type { SkillContributor } from "../src/types.js";
import { platformRecipientUsdcAta } from "../src/services/flex-facilitator.js";

// L1 + L4 cover for unbrowse-payments-faremeter wave 1. Pure-function unit
// tests against the real service code, no mocks. The on-chain settlement
// path is exercised by the existing integration coverage in
// tests/x402-skill-route.test.ts; this file pins the 50/50 + dedupe + L4
// contract that the facilitator depends on.

const PLATFORM = "PLATFORM_USDC_ATA_BASE58_PUBKEY";

function contributor(
  agent: string,
  wallet: string,
  cumulative_delta: number,
): SkillContributor {
  return {
    agent_id: agent,
    wallet_address: wallet,
    endpoints_contributed: 1,
    cumulative_delta,
    share: 0,
    first_contributed_at: "2026-01-01T00:00:00Z",
    last_contributed_at: "2026-05-17T00:00:00Z",
  };
}

describe("L1 PLATFORM_BPS is 50/50", () => {
  it("PLATFORM_BPS exported value is 5000 (50%)", () => {
    expect(PLATFORM_BPS).toBe(5000);
  });

  it("FLEX_MAX_SPLITS remains 5 per Faremeter Flex spec", () => {
    expect(FLEX_MAX_SPLITS).toBe(5);
  });
});

describe("L1 computeFlexSplits — contributor cardinality", () => {
  it("0 payable contributors returns empty (caller handles)", () => {
    expect(computeFlexSplits({ contributors: [] }, PLATFORM)).toEqual([]);
    expect(
      computeFlexSplits({ contributors: undefined }, PLATFORM),
    ).toEqual([]);
  });

  it("0 contributors with wallets returns empty (no payable)", () => {
    const noWallets: SkillContributor[] = [{
      agent_id: "a1",
      endpoints_contributed: 1,
      cumulative_delta: 1,
      share: 0,
      first_contributed_at: "2026-01-01T00:00:00Z",
      last_contributed_at: "2026-05-17T00:00:00Z",
    }];
    expect(computeFlexSplits({ contributors: noWallets }, PLATFORM)).toEqual([]);
  });

  it("1 contributor gets the contributor pool (5000bps) under the 50/50 split", () => {
    const splits = computeFlexSplits(
      { contributors: [contributor("a1", "WALLET_A", 10)] },
      PLATFORM,
    );
    expect(splits.length).toBe(2);
    expect(splits[0]).toEqual({ recipient: PLATFORM, bps: 5000 });
    expect(splits[1]).toEqual({ recipient: "WALLET_A", bps: 5000 });
    expect(splits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
  });

  it("3 contributors split the 5000bps contributor pool proportional to cumulative_delta", () => {
    const splits = computeFlexSplits(
      {
        contributors: [
          contributor("a1", "WALLET_A", 50),
          contributor("a2", "WALLET_B", 30),
          contributor("a3", "WALLET_C", 20),
        ],
      },
      PLATFORM,
    );
    expect(splits.length).toBe(4);
    expect(splits[0]).toEqual({ recipient: PLATFORM, bps: 5000 });
    expect(splits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
    // Top contributor (delta=50, 50% of contributor pool) gets ~2500bps.
    const a = splits.find((s) => s.recipient === "WALLET_A");
    const b = splits.find((s) => s.recipient === "WALLET_B");
    const c = splits.find((s) => s.recipient === "WALLET_C");
    expect(a?.bps).toBeGreaterThanOrEqual(b!.bps);
    expect(b?.bps).toBeGreaterThanOrEqual(c!.bps);
    expect(a!.bps + b!.bps + c!.bps).toBe(5000);
  });

  it("5 contributors collapse to top 4 (Flex MAX_SPLITS=5 minus 1 platform)", () => {
    const splits = computeFlexSplits(
      {
        contributors: [
          contributor("a1", "WALLET_A", 50),
          contributor("a2", "WALLET_B", 30),
          contributor("a3", "WALLET_C", 20),
          contributor("a4", "WALLET_D", 10),
          contributor("a5", "WALLET_E", 5),
        ],
      },
      PLATFORM,
    );
    // 4 contributor entries + 1 platform = 5 total = FLEX_MAX_SPLITS.
    expect(splits.length).toBe(FLEX_MAX_SPLITS);
    expect(splits.length).toBeLessThanOrEqual(FLEX_MAX_SPLITS);
    // a5 (smallest delta) is dropped, not paid out.
    expect(splits.find((s) => s.recipient === "WALLET_E")).toBeUndefined();
    expect(splits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
  });

  it("7 contributors also collapse to top 4 (no overflow into 6th entry)", () => {
    const splits = computeFlexSplits(
      {
        contributors: [
          contributor("a1", "WALLET_A", 100),
          contributor("a2", "WALLET_B", 50),
          contributor("a3", "WALLET_C", 25),
          contributor("a4", "WALLET_D", 12),
          contributor("a5", "WALLET_E", 6),
          contributor("a6", "WALLET_F", 3),
          contributor("a7", "WALLET_G", 1),
        ],
      },
      PLATFORM,
    );
    expect(splits.length).toBe(FLEX_MAX_SPLITS);
    expect(splits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
  });
});

describe("L1 mergeSplits — Faremeter duplicate-recipient guard", () => {
  it("duplicate contributor wallets collapse into one entry, summing bps", () => {
    const merged = mergeSplits([
      { recipient: PLATFORM, bps: 5000 },
      { recipient: "WALLET_A", bps: 3000 },
      { recipient: "WALLET_A", bps: 2000 }, // dup
    ]);
    expect(merged.length).toBe(2);
    expect(merged[0]).toEqual({ recipient: PLATFORM, bps: 5000 });
    expect(merged[1]).toEqual({ recipient: "WALLET_A", bps: 5000 });
    expect(merged.reduce((s, e) => s + e.bps, 0)).toBe(10000);
  });

  it("contributor wallet identical to platform collapses + sums bps", () => {
    const merged = mergeSplits([
      { recipient: PLATFORM, bps: 5000 },
      { recipient: PLATFORM, bps: 2500 },
      { recipient: "WALLET_B", bps: 2500 },
    ]);
    expect(merged.length).toBe(2);
    expect(merged[0]).toEqual({ recipient: PLATFORM, bps: 7500 });
  });

  it("computeFlexSplits with contributor wallet == platform produces a single platform entry", () => {
    const splits = computeFlexSplits(
      {
        contributors: [
          contributor("a1", PLATFORM, 10), // contributor is also platform
          contributor("a2", "WALLET_B", 10),
        ],
      },
      PLATFORM,
    );
    // 1 collapsed-platform + 1 distinct contributor = 2.
    expect(splits.length).toBe(2);
    expect(splits.reduce((s, e) => s + e.bps, 0)).toBe(10000);
    const platformEntry = splits.find((s) => s.recipient === PLATFORM);
    // platform's 5000 + a1's ~2500 = 7500
    expect(platformEntry!.bps).toBeGreaterThan(5000);
  });

  it("empty input passes through", () => {
    expect(mergeSplits([])).toEqual([]);
  });

  it("single entry passes through unchanged", () => {
    expect(mergeSplits([{ recipient: PLATFORM, bps: 10000 }])).toEqual([
      { recipient: PLATFORM, bps: 10000 },
    ]);
  });

  it("preserves first-appearance order so platform stays at index 0", () => {
    const merged = mergeSplits([
      { recipient: PLATFORM, bps: 3000 },
      { recipient: "B", bps: 4000 },
      { recipient: PLATFORM, bps: 2000 }, // re-appears
      { recipient: "C", bps: 1000 },
    ]);
    expect(merged.map((s) => s.recipient)).toEqual([PLATFORM, "B", "C"]);
  });
});

describe("L4 platformRecipientUsdcAta — boot validation", () => {
  function env(value: string | undefined): Parameters<typeof platformRecipientUsdcAta>[0] {
    return {
      FLEX_PLATFORM_RECIPIENT_USDC_ATA: value,
    } as Parameters<typeof platformRecipientUsdcAta>[0];
  }

  it("throws a helpful error when unset (caller bug: didn't set the env)", () => {
    expect(() => platformRecipientUsdcAta(env(undefined))).toThrow(
      /FLEX_PLATFORM_RECIPIENT_USDC_ATA not set/,
    );
    expect(() => platformRecipientUsdcAta(env(""))).toThrow(
      /FLEX_PLATFORM_RECIPIENT_USDC_ATA not set/,
    );
    expect(() => platformRecipientUsdcAta(env("   "))).toThrow(
      /FLEX_PLATFORM_RECIPIENT_USDC_ATA not set/,
    );
  });

  it("error message explains base-pubkey vs USDC-ATA confusion", () => {
    try {
      platformRecipientUsdcAta(env(undefined));
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("USDC associated token account");
      expect(msg).toContain("NOT the wallet's base pubkey");
      expect(msg).toContain("spl-token address");
    }
  });

  it("rejects an obviously-wrong placeholder (too short)", () => {
    expect(() => platformRecipientUsdcAta(env("placeholder"))).toThrow(
      /does not look like a base58 Solana address/,
    );
  });

  it("rejects a hex eth address (wrong alphabet)", () => {
    expect(() =>
      platformRecipientUsdcAta(env("0x0000000000000000000000000000000000000000")),
    ).toThrow(/does not look like a base58 Solana address/);
  });

  it("rejects a base58 string with the disallowed character 0", () => {
    // The 0 character is excluded from Solana base58. Faremeter would reject.
    expect(() =>
      platformRecipientUsdcAta(env("0".repeat(40))),
    ).toThrow(/does not look like a base58 Solana address/);
  });

  it("accepts the user-provided base wallet pubkey (passes the cheap structural check, even though it is conceptually the wallet not the ATA)", () => {
    // L4's loose validator can't distinguish a base wallet pubkey from a
    // USDC ATA without RPC. It WILL accept this string structurally; the
    // operator-side responsibility is to put the ATA, not the wallet,
    // here. The error message above tells them so.
    const v = platformRecipientUsdcAta(
      env("Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1"),
    );
    expect(v).toBe("Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1");
  });
});
