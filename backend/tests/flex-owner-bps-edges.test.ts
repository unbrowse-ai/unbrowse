/**
 * Step 4 edge tests for the OWNER_BPS lane in computeFlexSplits.
 *
 * Step 3 (flex-owner-bps.test.ts) pinned the happy paths. This file pins
 * the regression edges: rounding, zero/negative deltas, collisions
 * between owner ATA and contributor wallets, optional/whitespace fields,
 * idempotency, and mergeSplits order invariance.
 *
 * Every test maps to a concrete on-chain failure mode the Faremeter
 * Flex program rejects (duplicate recipients, bps sum != 10000, splits
 * count > FLEX_MAX_SPLITS, NaN / negative bps).
 *
 * No mocks. Pure-function unit tests against the real computeFlexSplits.
 */

import { test, expect } from "bun:test";
import {
  computeFlexSplits,
  OWNER_BPS,
  PLATFORM_BPS,
  FLEX_MAX_SPLITS,
  mergeSplits,
} from "../src/services/flex.js";
import type { SkillContributor } from "../src/types.js";

const PLATFORM = "PlAtFoRm1111111111111111111111111111111111";
const OWNER = "OwNeR222222222222222222222222222222222222222";

function contrib(addr: string, delta: number = 1): SkillContributor {
  return {
    agent_id: `agent-${addr.slice(0, 6)}`,
    wallet_address: addr,
    endpoints_contributed: 1,
    cumulative_delta: delta,
    share: 0,
    first_contributed_at: "2026-01-01T00:00:00Z",
    last_contributed_at: "2026-05-17T00:00:00Z",
  };
}

function sumBps(splits: { bps: number }[]): number {
  return splits.reduce((s, x) => s + x.bps, 0);
}

// ---------------------------------------------------------------------------
// 1. Rounding: 7 contributors at cumulative_delta=1, owner active.
//    Cap is FLEX_MAX_SPLITS - 2 = 3 contributors. The other 4 MUST be
//    dropped (length cap), and the bps sum MUST be exactly 10000 after
//    the normalize step (no off-by-one rounding regression).
// ---------------------------------------------------------------------------
test("edge: 7 contribs at delta=1 + owner active drops to 3 contribs, bps sum is exactly 10000", () => {
  const wallets = [
    "AaA1111111111111111111111111111111111111111",
    "BbB2222222222222222222222222222222222222222",
    "CcC3333333333333333333333333333333333333333",
    "DdD4444444444444444444444444444444444444444",
    "EeE5555555555555555555555555555555555555555",
    "FfF6666666666666666666666666666666666666666",
    "GgG7777777777777777777777777777777777777777",
  ];
  const splits = computeFlexSplits(
    {
      contributors: wallets.map((w) => contrib(w, 1)),
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: OWNER,
    },
    PLATFORM,
  );

  // platform + owner + 3 contributors = 5 entries.
  expect(splits.length).toBe(FLEX_MAX_SPLITS);
  expect(sumBps(splits)).toBe(10000);

  // The 4 lowest-priority (by sort-stability) contributors are dropped.
  const seenContributorWallets = new Set(
    splits
      .map((s) => s.recipient)
      .filter((r) => r !== PLATFORM && r !== OWNER),
  );
  expect(seenContributorWallets.size).toBe(FLEX_MAX_SPLITS - 2);

  // Platform + owner pin the headline numbers.
  expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(PLATFORM_BPS);
  expect(splits.find((s) => s.recipient === OWNER)?.bps).toBe(OWNER_BPS);

  // Surviving contributors share exactly contributorPool = 3000 bps.
  const contributorSum = splits
    .filter((s) => s.recipient !== PLATFORM && s.recipient !== OWNER)
    .reduce((s, x) => s + x.bps, 0);
  expect(contributorSum).toBe(10000 - PLATFORM_BPS - OWNER_BPS);
});

// ---------------------------------------------------------------------------
// 2. Zero cumulative_delta only: Math.max(c.cumulative_delta, 0.01) floor
//    must keep the math finite (no NaN, no negative, no zero bps).
// ---------------------------------------------------------------------------
test("edge: all contributors at delta=0 produce finite, positive, non-NaN bps", () => {
  const splits = computeFlexSplits(
    {
      contributors: [
        contrib("AaA1111111111111111111111111111111111111111", 0),
        contrib("BbB2222222222222222222222222222222222222222", 0),
        contrib("CcC3333333333333333333333333333333333333333", 0),
      ],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: OWNER,
    },
    PLATFORM,
  );

  expect(sumBps(splits)).toBe(10000);
  for (const s of splits) {
    expect(Number.isFinite(s.bps)).toBe(true);
    expect(Number.isNaN(s.bps)).toBe(false);
    expect(s.bps).toBeGreaterThan(0);
  }
  // Owner + platform pin to fixed bps.
  expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(PLATFORM_BPS);
  expect(splits.find((s) => s.recipient === OWNER)?.bps).toBe(OWNER_BPS);
});

// ---------------------------------------------------------------------------
// 3. One contributor with negative cumulative_delta. Pin the actual
//    behavior: the floor Math.max(delta, 0.01) saves the math; the
//    contributor is NOT filtered out (filter only checks wallet_address).
// ---------------------------------------------------------------------------
test("edge: lone contributor with negative cumulative_delta is floored, not dropped", () => {
  const W = "NeGgGgGgGgGgGgGgGgGgGgGgGgGgGgGgGgGgGgGgGgGg";
  const splits = computeFlexSplits(
    {
      contributors: [contrib(W, -5)],
      owner_compensation_opt_in: false,
      owner_wallet_usdc_ata: "",
    },
    PLATFORM,
  );
  // Platform + 1 contributor (negative delta floored, not filtered).
  expect(splits.length).toBe(2);
  expect(splits.find((s) => s.recipient === W)?.bps).toBe(5000);
  expect(sumBps(splits)).toBe(10000);
});

// ---------------------------------------------------------------------------
// 4. Owner USDC ATA equals THE only contributor's wallet address.
//    mergeSplits collapses to one entry summing OWNER_BPS + 3000 = 5000.
// ---------------------------------------------------------------------------
test("edge: owner ATA == sole contributor wallet collapses to one entry", () => {
  const SHARED = "ShArEdShArEdShArEdShArEdShArEdShArEdShArEdSh";
  const splits = computeFlexSplits(
    {
      contributors: [contrib(SHARED, 100)],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: SHARED, // owner ATA == contributor wallet
    },
    PLATFORM,
  );
  // platform + 1 merged (owner+contrib) = 2 entries.
  expect(splits.length).toBe(2);
  expect(sumBps(splits)).toBe(10000);
  const sharedLane = splits.find((s) => s.recipient === SHARED)!;
  // OWNER_BPS (2000) + contributor pool (3000) = 5000.
  expect(sharedLane.bps).toBe(OWNER_BPS + (10000 - PLATFORM_BPS - OWNER_BPS));
  expect(sharedLane.bps).toBe(5000);
});

// ---------------------------------------------------------------------------
// 5. Owner USDC ATA equals ONE of multiple contributor wallets.
// ---------------------------------------------------------------------------
test("edge: owner ATA == one of several contributor wallets collapses that lane only", () => {
  const SHARED = "ShArEdShArEdShArEdShArEdShArEdShArEdShArEdSh";
  const OTHER_A = "OtHeRaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
  const OTHER_B = "OtHeRbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";
  const splits = computeFlexSplits(
    {
      contributors: [
        contrib(SHARED, 100),
        contrib(OTHER_A, 50),
        contrib(OTHER_B, 25),
      ],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: SHARED,
    },
    PLATFORM,
  );
  // platform + (owner+SHARED merged) + OTHER_A + OTHER_B = 4 entries.
  expect(splits.length).toBe(4);
  expect(sumBps(splits)).toBe(10000);

  const platformLane = splits.find((s) => s.recipient === PLATFORM)!;
  expect(platformLane.bps).toBe(PLATFORM_BPS);

  const sharedLane = splits.find((s) => s.recipient === SHARED)!;
  // Owner's 2000 + this contributor's portion of the 3000 contributor pool.
  // Weights: 100/175, 50/175, 25/175. SHARED's share = round(100/175 * 3000) = 1714.
  // After OWNER_BPS=2000 added: ~3714. Pin >= 3000 (owner) + smallest plausible (1).
  expect(sharedLane.bps).toBeGreaterThan(OWNER_BPS);
  expect(sharedLane.bps).toBeLessThan(OWNER_BPS + (10000 - PLATFORM_BPS - OWNER_BPS));

  // OTHER_A and OTHER_B stay distinct.
  expect(splits.find((s) => s.recipient === OTHER_A)).toBeDefined();
  expect(splits.find((s) => s.recipient === OTHER_B)).toBeDefined();
});

// ---------------------------------------------------------------------------
// 6. Owner active + zero contributors + platform == owner ATA.
//    Everything collapses to a single recipient at 10000 bps.
// ---------------------------------------------------------------------------
test("edge: owner active + zero contribs + platform==owner ATA collapses to one entry at 10000", () => {
  const splits = computeFlexSplits(
    {
      contributors: [],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: PLATFORM, // same as platform
    },
    PLATFORM,
  );
  expect(splits.length).toBe(1);
  expect(splits[0]!.recipient).toBe(PLATFORM);
  expect(splits[0]!.bps).toBe(10000);
});

// ---------------------------------------------------------------------------
// 7. owner_compensation_opt_in: undefined behaves like false.
// ---------------------------------------------------------------------------
test("edge: owner_compensation_opt_in=undefined behaves like false (no owner lane)", () => {
  const splits = computeFlexSplits(
    {
      contributors: [contrib("ContriB111111111111111111111111111111111111", 100)],
      // opt_in undefined; ATA set — owner branch must stay dormant.
      owner_wallet_usdc_ata: OWNER,
    },
    PLATFORM,
  );
  expect(splits.find((s) => s.recipient === OWNER)).toBeUndefined();
  expect(sumBps(splits)).toBe(10000);
  // Contributor gets full contributor pool = 5000 (owner-inactive split).
  expect(
    splits.find((s) => s.recipient === "ContriB111111111111111111111111111111111111")?.bps,
  ).toBe(5000);
});

// ---------------------------------------------------------------------------
// 8. owner_wallet_usdc_ata = "   " (whitespace only) — trim() empties it,
//    so the owner branch stays dormant even with opt_in=true.
// ---------------------------------------------------------------------------
test("edge: owner_wallet_usdc_ata is whitespace-only -> owner lane dormant", () => {
  const splits = computeFlexSplits(
    {
      contributors: [contrib("ContriB111111111111111111111111111111111111", 100)],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: "   ",
    },
    PLATFORM,
  );
  // No owner lane; contributor gets the full 5000 pool.
  expect(splits.length).toBe(2);
  expect(splits.find((s) => s.recipient === OWNER)).toBeUndefined();
  expect(sumBps(splits)).toBe(10000);
});

// ---------------------------------------------------------------------------
// 9. Idempotency: calling computeFlexSplits twice with the same input
//    produces deep-equal output. Pure-function discipline.
// ---------------------------------------------------------------------------
test("edge: computeFlexSplits is idempotent (deep-equal output on re-call)", () => {
  const input = {
    contributors: [
      contrib("AaA1111111111111111111111111111111111111111", 100),
      contrib("BbB2222222222222222222222222222222222222222", 50),
      contrib("CcC3333333333333333333333333333333333333333", 25),
    ],
    owner_compensation_opt_in: true,
    owner_wallet_usdc_ata: OWNER,
  };
  const a = computeFlexSplits(input, PLATFORM);
  const b = computeFlexSplits(input, PLATFORM);
  expect(a).toEqual(b);
  // Stronger: byte-level JSON equality.
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

// ---------------------------------------------------------------------------
// 10. mergeSplits order invariance: per the docstring, order is preserved
//     by FIRST appearance. Swapping the input order must change the
//     output order accordingly.
// ---------------------------------------------------------------------------
test("edge: mergeSplits preserves first-appearance order regardless of input order", () => {
  const platformFirst = mergeSplits([
    { recipient: PLATFORM, bps: 5000 },
    { recipient: OWNER, bps: 2000 },
    { recipient: "ContriB111111111111111111111111111111111111", bps: 3000 },
  ]);
  expect(platformFirst.map((s) => s.recipient)).toEqual([
    PLATFORM,
    OWNER,
    "ContriB111111111111111111111111111111111111",
  ]);

  const contribFirst = mergeSplits([
    { recipient: "ContriB111111111111111111111111111111111111", bps: 3000 },
    { recipient: PLATFORM, bps: 5000 },
    { recipient: OWNER, bps: 2000 },
  ]);
  expect(contribFirst.map((s) => s.recipient)).toEqual([
    "ContriB111111111111111111111111111111111111",
    PLATFORM,
    OWNER,
  ]);

  // Sum invariant holds in both orderings.
  expect(sumBps(platformFirst)).toBe(10000);
  expect(sumBps(contribFirst)).toBe(10000);
});
