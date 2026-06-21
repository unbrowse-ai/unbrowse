/**
 * JESPA witness for proof-of-indexing + staking game theory.
 *
 * The native mechanism must make honest indexing the dominant useful strategy:
 * rewards follow verified proof quality, stake is collateral rather than a rank
 * shortcut, Sybil splitting is invariant, stale/false indexing is slashable, and
 * spurious challenges lose their bond. This is the mechanism-design test behind
 * the proof-of-indexing economy paper section.
 */
import { expect, test } from "bun:test";
import {
  coalitionReward,
  proofScore,
  rankByProofQuality,
  rewardWeights,
  simulateEconomy,
  splitRewards,
  type CanonicalRoute,
  type IndexerState,
} from "../src/values/proof-indexing-economy.js";

const ROUTES: CanonicalRoute[] = [
  { routeId: "checkout.add", contentHash: "h:add:v2", now: 1_000 },
  { routeId: "checkout.pay", contentHash: "h:pay:v4", now: 1_000 },
  { routeId: "account.wallet", contentHash: "h:wallet:v1", now: 1_000 },
];

const honest: IndexerState = {
  id: "honest",
  stake: 100,
  free: 0,
  attestations: [
    { routeId: "checkout.add", contentHash: "h:add:v2", indexedAt: 990 },
    { routeId: "checkout.pay", contentHash: "h:pay:v4", indexedAt: 995 },
    { routeId: "account.wallet", contentHash: "h:wallet:v1", indexedAt: 999 },
  ],
};

const lazy: IndexerState = {
  id: "lazy",
  stake: 100,
  free: 0,
  attestations: [
    { routeId: "checkout.add", contentHash: "h:add:old", indexedAt: 990 },
    { routeId: "checkout.pay", contentHash: "h:pay:v4", indexedAt: 200 },
  ],
};

test("verified proof quality, not stake alone, ranks indexers", () => {
  const whaleLazy = { ...lazy, id: "whale-lazy", stake: 10_000 };
  const ranking = rankByProofQuality([whaleLazy, honest], ROUTES, 100);
  expect(ranking[0].indexer).toBe("honest");
  expect(ranking[0].score).toBe(1);
  expect(proofScore(whaleLazy, ROUTES, 100).score).toBe(0);
});

test("honest indexing earns more than lazy/stale indexing under the mechanism", () => {
  const r = simulateEconomy([honest, lazy], ROUTES, [], { rewardPool: 100, ttl: 100, slashBps: 5_000 });
  expect(r.rewards.honest).toBe(100);
  expect(r.rewards.lazy ?? 0).toBe(0);
  expect(r.freeAfter.honest).toBeGreaterThan(r.freeAfter.lazy);
});

test("Sybil splitting one stake across identities gives no additional reward", () => {
  const unifiedWeights = rewardWeights([honest], ROUTES, 100);
  const unified = splitRewards(99, unifiedWeights);

  const sybils: IndexerState[] = [
    { ...honest, id: "s1", stake: 34 },
    { ...honest, id: "s2", stake: 33 },
    { ...honest, id: "s3", stake: 33 },
  ];
  const split = splitRewards(99, rewardWeights(sybils, ROUTES, 100));

  expect(coalitionReward(unified, ["honest"])).toBe(99);
  expect(coalitionReward(split, ["s1", "s2", "s3"])).toBe(99);
});

test("a stale or false proof is slashable by re-derivation", () => {
  const r = simulateEconomy(
    [honest, lazy],
    ROUTES,
    [{ challenger: "watcher", indexer: "lazy", routeId: "checkout.add", bond: 40 }],
    { rewardPool: 100, ttl: 100, slashBps: 5_000 },
  );

  expect(r.verdicts).toEqual([
    { verdict: "slashed", challenger: "watcher", indexer: "lazy", routeId: "checkout.add", bond: 40, amount: 40 },
  ]);
  expect(r.stakeAfter.lazy).toBe(60);
  expect(r.freeAfter.watcher).toBe(80);
});

test("a spurious challenge forfeits its bond to the honest indexer", () => {
  const r = simulateEconomy(
    [{ ...honest, free: 0 }],
    ROUTES,
    [{ challenger: "griefer", indexer: "honest", routeId: "checkout.pay", bond: 30 }],
    { rewardPool: 0, ttl: 100, slashBps: 5_000 },
  );

  expect(r.verdicts[0].verdict).toBe("challenge_failed");
  expect(r.stakeAfter.honest).toBe(130);
  expect(r.freeAfter.griefer).toBe(0);
});

test("the ledger is conservative: stake plus free balance plus rewards is conserved", () => {
  const r = simulateEconomy(
    [{ ...honest, free: 5 }, { ...lazy, free: 7 }],
    ROUTES,
    [{ challenger: "watcher", indexer: "lazy", routeId: "checkout.add", bond: 40 }],
    { rewardPool: 100, ttl: 100, slashBps: 5_000 },
  );
  expect(r.totalAfter).toBe(r.totalBefore);
});
