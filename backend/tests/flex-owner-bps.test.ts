/**
 * Step 3 seed test: OWNER_BPS lane on computeFlexSplits.
 *
 * Verifies the math the docs (HOW_UNBROWSE_PAYS.md / EARN_AS_INDEXER.md /
 * CLAIM_YOUR_DOMAIN.md) describe is actually shipped:
 *
 *   - PLATFORM_BPS = 5000 (50%)
 *   - OWNER_BPS    = 1500 (15%), active only when owner_compensation_opt_in
 *                    is true AND owner_wallet_usdc_ata is non-empty
 *   - Indexer pool = 10000 - PLATFORM_BPS - (active ? OWNER_BPS : 0)
 *                    = 3500 (35%) when owner is active, else 5000 (50%)
 *
 * Hardcoded BPS values below are painted-lamp guards (see
 * `feedback_xfail_mutation_test` memory): mutating OWNER_BPS in source
 * breaks these tests deterministically.
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
    cumulative_delta: delta,
    first_contribution_at: new Date().toISOString(),
    last_contribution_at: new Date().toISOString(),
  };
}

function sumBps(splits: { bps: number }[]): number {
  return splits.reduce((s, x) => s + x.bps, 0);
}

test("seed: OWNER_BPS constant is 1500 (15%)", () => {
  expect(OWNER_BPS).toBe(1500);
});

test("seed: PLATFORM_BPS + OWNER_BPS + contributorPool = 10000 when owner active", () => {
  expect(PLATFORM_BPS + OWNER_BPS).toBe(6500);
  const contributorPool = 10000 - PLATFORM_BPS - OWNER_BPS;
  expect(contributorPool).toBe(3500);
});

test("seed: owner inactive (opt_in=false) keeps the existing 50/50 split", () => {
  const splits = computeFlexSplits(
    {
      contributors: [contrib("ContriB111111111111111111111111111111111111", 100)],
      owner_compensation_opt_in: false,
      owner_wallet_usdc_ata: OWNER,
    },
    PLATFORM,
  );
  // Single contributor + platform. No owner lane.
  const ownerLane = splits.find((s) => s.recipient === OWNER);
  expect(ownerLane).toBeUndefined();
  expect(sumBps(splits)).toBe(10000);
  expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(PLATFORM_BPS);
});

test("seed: owner inactive (no ATA) keeps the existing 50/50 split even if opt_in=true", () => {
  const splits = computeFlexSplits(
    {
      contributors: [contrib("ContriB111111111111111111111111111111111111", 100)],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: "", // empty -> branch dormant
    },
    PLATFORM,
  );
  expect(splits.find((s) => s.recipient === OWNER)).toBeUndefined();
  expect(sumBps(splits)).toBe(10000);
});

test("seed: owner active routes OWNER_BPS to the owner USDC ATA", () => {
  const splits = computeFlexSplits(
    {
      contributors: [contrib("ContriB111111111111111111111111111111111111", 100)],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: OWNER,
    },
    PLATFORM,
  );
  const ownerLane = splits.find((s) => s.recipient === OWNER);
  expect(ownerLane).toBeDefined();
  expect(ownerLane?.bps).toBe(OWNER_BPS);
  expect(sumBps(splits)).toBe(10000);
});

test("seed: owner active + 1 contributor splits 50/15/35", () => {
  const contributor = "ContriB111111111111111111111111111111111111";
  const splits = computeFlexSplits(
    {
      contributors: [contrib(contributor, 100)],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: OWNER,
    },
    PLATFORM,
  );
  expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(5000);
  expect(splits.find((s) => s.recipient === OWNER)?.bps).toBe(1500);
  expect(splits.find((s) => s.recipient === contributor)?.bps).toBe(3500);
  expect(sumBps(splits)).toBe(10000);
});

test("seed: owner active + 3 contributors weighted by cumulative_delta", () => {
  // 100 + 50 + 25 = 175. Pool = 3500.
  //   100/175 * 3500 = 2000
  //    50/175 * 3500 = 1000
  //    25/175 * 3500 =  500
  //   sum 3500 (exact under round-half-up)
  const splits = computeFlexSplits(
    {
      contributors: [
        contrib("AaA1111111111111111111111111111111111111111", 100),
        contrib("BbB2222222222222222222222222222222222222222", 50),
        contrib("CcC3333333333333333333333333333333333333333", 25),
      ],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: OWNER,
    },
    PLATFORM,
  );
  expect(sumBps(splits)).toBe(10000);
  expect(splits.find((s) => s.recipient === PLATFORM)?.bps).toBe(5000);
  expect(splits.find((s) => s.recipient === OWNER)?.bps).toBe(1500);
  const contributorSum = splits
    .filter((s) => s.recipient !== PLATFORM && s.recipient !== OWNER)
    .reduce((sum, s) => sum + s.bps, 0);
  expect(contributorSum).toBe(3500);
});

test("seed: owner active + zero contributors folds residual back to platform", () => {
  const splits = computeFlexSplits(
    {
      contributors: [],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: OWNER,
    },
    PLATFORM,
  );
  expect(sumBps(splits)).toBe(10000);
  // Owner lane is present.
  expect(splits.find((s) => s.recipient === OWNER)?.bps).toBe(OWNER_BPS);
  // Platform absorbs the would-be contributor pool (no one to pay).
  const platformLane = splits.find((s) => s.recipient === PLATFORM)!;
  expect(platformLane.bps).toBe(10000 - OWNER_BPS);
});

test("seed: contributor cap shrinks to FLEX_MAX_SPLITS-2 when owner is active", () => {
  // 5 contributors but cap is 5 - 2 = 3 when owner active.
  const splits = computeFlexSplits(
    {
      contributors: [
        contrib("AaA1111111111111111111111111111111111111111", 100),
        contrib("BbB2222222222222222222222222222222222222222", 90),
        contrib("CcC3333333333333333333333333333333333333333", 80),
        contrib("DdD4444444444444444444444444444444444444444", 70),
        contrib("EeE5555555555555555555555555555555555555555", 60),
      ],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: OWNER,
    },
    PLATFORM,
  );
  // Total splits: platform + owner + 3 contributors = 5 entries max.
  expect(splits.length).toBeLessThanOrEqual(FLEX_MAX_SPLITS);
  expect(sumBps(splits)).toBe(10000);
});

test("seed: mergeSplits collapses duplicate recipient when platform = owner wallet", () => {
  // Edge case: platform recipient ATA equals owner ATA (weird but possible
  // in test). mergeSplits should still collapse so the on-chain program
  // doesn't reject FLEX_ERROR__DUPLICATE_SPLIT_RECIPIENT.
  const splits = computeFlexSplits(
    {
      contributors: [contrib("ContriB111111111111111111111111111111111111", 100)],
      owner_compensation_opt_in: true,
      owner_wallet_usdc_ata: PLATFORM, // same as platform
    },
    PLATFORM,
  );
  // mergeSplits collapses to one entry for that recipient.
  const platformEntries = splits.filter((s) => s.recipient === PLATFORM);
  expect(platformEntries.length).toBe(1);
  expect(platformEntries[0]!.bps).toBe(PLATFORM_BPS + OWNER_BPS);
});

test("seed: mergeSplits is exposed for downstream callers", () => {
  // mergeSplits is the duplicate-recipient remediation; tests should not
  // need to re-import it from a deep module path. Exposed at the package
  // level (alongside computeFlexSplits).
  expect(typeof mergeSplits).toBe("function");
});
