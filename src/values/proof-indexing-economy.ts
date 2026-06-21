/**
 * proof-indexing-economy - native game-theory primitive for proof-of-indexing
 * and staking.
 *
 * This promotes the paper/reference Python economy into the TypeScript runtime:
 * an indexer earns only when its signed route attestations re-derive against
 * canonical content and freshness; stake is collateral/reward weight, never a
 * ranking shortcut. The useful equilibrium is honest maintenance: lazy/stale
 * indexing is slashable, false challenges are costly, and splitting one stake
 * across many identities gives no extra influence.
 */

export interface CanonicalRoute {
  routeId: string;
  contentHash: string;
  now: number;
}

export interface IndexingAttestation {
  routeId: string;
  contentHash: string;
  indexedAt: number;
}

export interface IndexerState {
  id: string;
  stake: number;
  free?: number;
  attestations: IndexingAttestation[];
}

export interface ProofScore {
  indexer: string;
  covered: number;
  validFresh: number;
  invalid: number;
  stale: number;
  score: number;
}

export interface Challenge {
  challenger: string;
  indexer: string;
  routeId: string;
  bond: number;
}

export interface ChallengeVerdict {
  verdict: "slashed" | "challenge_failed" | "no_attestation";
  challenger: string;
  indexer: string;
  routeId: string;
  bond: number;
  amount: number;
}

export interface EconomyParams {
  rewardPool: number;
  ttl: number;
  slashBps: number;
}

export interface EconomyResult {
  scores: ProofScore[];
  rewards: Record<string, number>;
  stakeAfter: Record<string, number>;
  freeAfter: Record<string, number>;
  verdicts: ChallengeVerdict[];
  totalBefore: number;
  totalAfter: number;
}

const BPS = 10_000;

export function proofScore(indexer: IndexerState, canonical: CanonicalRoute[], ttl: number): ProofScore {
  const byRoute = new Map(indexer.attestations.map((a) => [a.routeId, a]));
  let validFresh = 0;
  let invalid = 0;
  let stale = 0;

  for (const route of canonical) {
    const att = byRoute.get(route.routeId);
    if (!att) continue;
    const age = route.now - att.indexedAt;
    const fresh = age >= 0 && age <= ttl;
    if (att.contentHash !== route.contentHash) invalid++;
    else if (!fresh) stale++;
    else validFresh++;
  }

  const covered = canonical.filter((r) => byRoute.has(r.routeId)).length;
  const denominator = Math.max(1, canonical.length);
  return {
    indexer: indexer.id,
    covered,
    validFresh,
    invalid,
    stale,
    score: validFresh / denominator,
  };
}

export function rankByProofQuality(indexers: IndexerState[], canonical: CanonicalRoute[], ttl: number): ProofScore[] {
  return indexers
    .map((i) => proofScore(i, canonical, ttl))
    .sort((a, b) =>
      b.score - a.score ||
      b.validFresh - a.validFresh ||
      a.invalid + a.stale - (b.invalid + b.stale) ||
      a.indexer.localeCompare(b.indexer),
    );
}

export function rewardWeights(indexers: IndexerState[], canonical: CanonicalRoute[], ttl: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const indexer of indexers) {
    const score = proofScore(indexer, canonical, ttl).score;
    out[indexer.id] = Math.max(0, indexer.stake) * score;
  }
  return out;
}

export function splitRewards(rewardPool: number, weights: Record<string, number>): Record<string, number> {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (rewardPool <= 0 || total <= 0) return {};
  const rewards: Record<string, number> = {};
  let assigned = 0;
  const remainders: Array<{ id: string; rem: number }> = [];
  for (const [id, weight] of Object.entries(weights)) {
    const exact = (rewardPool * weight) / total;
    const base = Math.floor(exact);
    rewards[id] = base;
    assigned += base;
    remainders.push({ id, rem: exact - base });
  }
  for (const r of remainders.sort((a, b) => b.rem - a.rem || a.id.localeCompare(b.id)).slice(0, rewardPool - assigned)) {
    rewards[r.id]++;
  }
  return rewards;
}

export function coalitionReward(rewards: Record<string, number>, ids: Iterable<string>): number {
  let n = 0;
  for (const id of ids) n += rewards[id] ?? 0;
  return n;
}

function attestationFor(indexer: IndexerState, routeId: string): IndexingAttestation | undefined {
  return indexer.attestations.find((a) => a.routeId === routeId);
}

function routeFor(canonical: CanonicalRoute[], routeId: string): CanonicalRoute | undefined {
  return canonical.find((r) => r.routeId === routeId);
}

function attestationFails(att: IndexingAttestation | undefined, route: CanonicalRoute | undefined, ttl: number): boolean | null {
  if (!att || !route) return null;
  const age = route.now - att.indexedAt;
  return att.contentHash !== route.contentHash || age < 0 || age > ttl;
}

export function simulateEconomy(
  indexers: IndexerState[],
  canonical: CanonicalRoute[],
  challenges: Challenge[],
  params: EconomyParams,
): EconomyResult {
  const stakeAfter: Record<string, number> = {};
  const freeAfter: Record<string, number> = {};
  for (const i of indexers) {
    stakeAfter[i.id] = i.stake;
    freeAfter[i.id] = i.free ?? 0;
  }
  for (const c of challenges) {
    if (!(c.challenger in stakeAfter)) stakeAfter[c.challenger] = 0;
    if (!(c.challenger in freeAfter)) freeAfter[c.challenger] = c.bond;
  }

  const totalBefore =
    Object.values(stakeAfter).reduce((a, b) => a + b, 0) +
    Object.values(freeAfter).reduce((a, b) => a + b, 0) +
    params.rewardPool;

  const verdicts: ChallengeVerdict[] = [];
  for (const challenge of challenges) {
    const indexer = indexers.find((i) => i.id === challenge.indexer);
    const route = routeFor(canonical, challenge.routeId);
    const att = indexer ? attestationFor(indexer, challenge.routeId) : undefined;
    const fails = attestationFails(att, route, params.ttl);

    if (freeAfter[challenge.challenger] < challenge.bond) {
      verdicts.push({ verdict: "challenge_failed", ...challenge, amount: 0 });
      continue;
    }
    freeAfter[challenge.challenger] -= challenge.bond;

    if (fails === null) {
      freeAfter[challenge.challenger] += challenge.bond;
      verdicts.push({ verdict: "no_attestation", ...challenge, amount: 0 });
    } else if (fails) {
      const slash = Math.min(challenge.bond, Math.floor((stakeAfter[challenge.indexer] * params.slashBps) / BPS));
      stakeAfter[challenge.indexer] -= slash;
      freeAfter[challenge.challenger] += challenge.bond + slash;
      verdicts.push({ verdict: "slashed", ...challenge, amount: slash });
    } else {
      stakeAfter[challenge.indexer] += challenge.bond;
      verdicts.push({ verdict: "challenge_failed", ...challenge, amount: challenge.bond });
    }
  }

  const rewards = splitRewards(params.rewardPool, rewardWeights(indexers.map((i) => ({ ...i, stake: stakeAfter[i.id] })), canonical, params.ttl));
  for (const [id, reward] of Object.entries(rewards)) freeAfter[id] = (freeAfter[id] ?? 0) + reward;

  const totalAfter =
    Object.values(stakeAfter).reduce((a, b) => a + b, 0) +
    Object.values(freeAfter).reduce((a, b) => a + b, 0);

  return {
    scores: rankByProofQuality(indexers, canonical, params.ttl),
    rewards,
    stakeAfter,
    freeAfter,
    verdicts,
    totalBefore,
    totalAfter,
  };
}
