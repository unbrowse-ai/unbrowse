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
