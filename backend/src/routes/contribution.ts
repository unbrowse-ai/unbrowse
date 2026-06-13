/**
 * contribution — the validation-registry GATE (plan node 5,
 * internal/zk-delta-contribution-plan.md). SERVER-ONLY. ERC-8004 "Validation Registry"
 * shape: a contribution is admitted into the shared graph only after its bounded-validity
 * proof (node 2) and execution attestation (node 3) verify; the verified contribution is
 * then recorded for fair x402 settlement, and a forged proof is rejected end-to-end and
 * never earns. The in-process handler here is what a Hono route binds to; live x402
 * payout + on-chain registry anchoring are the deployment step (the existing fare-split
 * logic does the four-way payout — this records WHO earns, verifiably).
 */
import {
  mergeDelta, graphRoot, type SharedGraph, type Contribution,
} from "../services/graph-merge/index.js";
import { deltaId } from "../../../src/values/route-delta.js";

/** An audit record of an ADMITTED contribution (the verified attribution trail). */
export interface ContributionRecord {
  deltaId: string;
  endpoint: string;
  contributor: string; // wallet root hex
  freshness: number;
  seq: number;
}

export interface ContributionLedger {
  records: ContributionRecord[];
}

export function emptyLedger(): ContributionLedger {
  return { records: [] };
}

/** The gate's receipt — admitted with attribution, or rejected with a reason. */
export interface ContributionReceipt {
  admitted: boolean;
  reason?: string;
  deltaId?: string;
  endpoint?: string;
  contributor?: string;
  graphRoot?: string;
}

/**
 * Validate a contribution against the gate and, on success, merge it into the shared
 * graph and append the verified attribution record. A forged / unproven / unattested
 * contribution is rejected here — it never reaches the ledger and never earns.
 */
export function submitContribution(
  g: SharedGraph,
  ledger: ContributionLedger,
  c: Contribution,
): ContributionReceipt {
  const res = mergeDelta(g, c);
  if (!res.admitted) return { admitted: false, reason: res.reason };
  const record: ContributionRecord = {
    deltaId: deltaId(c.delta),
    endpoint: c.delta.endpoint,
    contributor: c.delta.walletRoot,
    freshness: c.delta.freshness,
    seq: ledger.records.length,
  };
  ledger.records.push(record);
  return {
    admitted: true,
    deltaId: record.deltaId,
    endpoint: record.endpoint,
    contributor: record.contributor,
    graphRoot: graphRoot(g),
  };
}

/** A settlement share owed to the verified contributor of an executed route. */
export interface ContributorSplit {
  contributor: string;
  endpoint: string;
  amountUsd: number;
}

/**
 * The contributor share of a paid execution on `endpoint` goes to the CURRENT verified
 * winner in the shared graph — the freshest admitted delta for that route. A contribution
 * that never passed the gate is never a winner, so it can never be paid. Returns null if
 * no verified route exists for the endpoint. (Platform / owner / discoverer shares are the
 * existing fare-split; this is the contributor leg, attributed by proof.)
 */
export function settleContributorShare(
  g: SharedGraph,
  endpoint: string,
  amountUsd: number,
  contributorBps = 1500,
): ContributorSplit | null {
  const winner = g.winners.get(endpoint);
  if (!winner) return null;
  return {
    contributor: winner.walletRoot,
    endpoint,
    amountUsd: (amountUsd * contributorBps) / 10_000,
  };
}

/** The four-way fare split (basis points; must sum to 10000). */
export interface SplitConfig {
  platformBps: number;
  ownerBps: number;
  contributorBps: number;
  discovererBps: number;
}

/** Default split — platform 15% / site owner 50% / contributor 15% / first discoverer 20%. */
export const DEFAULT_SPLIT: SplitConfig = { platformBps: 1500, ownerBps: 5000, contributorBps: 1500, discovererBps: 2000 };

/** The settled four-way payout for one paid execution. Amounts sum to `amountUsd`. */
export interface ExecutionSettlement {
  endpoint: string;
  amountUsd: number;
  platform: number;
  owner: number;
  contributor: { recipient: string | null; amountUsd: number };
  discoverer: number;
}

/**
 * Settle a paid execution on `endpoint` across the four-way split. The contributor leg is
 * paid to the VERIFIED graph winner (the freshest admitted, proof-gated delta) — never to a
 * contribution that failed the gate. When no verified contributor exists, that leg is 0 and
 * its share is absorbed by the platform, so the legs always sum to `amountUsd`. Moving the
 * USDC over x402 is the existing payment rail (the deploy step); this decides WHO is paid.
 */
export function settleExecution(
  g: SharedGraph,
  endpoint: string,
  amountUsd: number,
  split: SplitConfig = DEFAULT_SPLIT,
): ExecutionSettlement {
  const sum = split.platformBps + split.ownerBps + split.contributorBps + split.discovererBps;
  if (sum !== 10_000) throw new Error(`split must sum to 10000 bps, got ${sum}`);
  const part = (bps: number) => (amountUsd * bps) / 10_000;
  const winner = g.winners.get(endpoint) ?? null;
  const contributorAmt = winner ? part(split.contributorBps) : 0;
  return {
    endpoint,
    amountUsd,
    // platform absorbs the contributor leg when no verified contributor earns it
    platform: part(split.platformBps) + (winner ? 0 : part(split.contributorBps)),
    owner: part(split.ownerBps),
    contributor: { recipient: winner ? winner.walletRoot : null, amountUsd: contributorAmt },
    discoverer: part(split.discovererBps),
  };
}
