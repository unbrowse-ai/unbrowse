/**
 * indexing-investment - funding taps for new indexing contracts.
 *
 * This is the contract-native funding seam for Paper 3's maintenance economy:
 * USDC-style funds can seed new indexing contracts across dimensions, but funds
 * never buy resolve ranking. Ranking still comes from proof quality; this module
 * only produces a conserved allocation plan that can be mirrored to the on-chain
 * contract ledger by the caller.
 */

export type IndexingDimension = "route" | "auth" | "security" | "freshness" | "execution" | string;

export interface IndexingContractProposal {
  contractId: string;
  indexer: string;
  dimensions: readonly IndexingDimension[];
  requestedAmount: number;
  proofScore: number;
  bondedAmount: number;
}

export interface InvestmentPolicy {
  minProofScore: number;
  minBond: number;
  dimensionWeights?: Readonly<Record<string, number>>;
}

export interface InvestmentAllocation {
  contractId: string;
  indexer: string;
  amount: number;
  weight: number;
  dimensions: readonly IndexingDimension[];
  rankEffect: "none";
}

export interface InvestmentTapPlan {
  investor: string;
  amount: number;
  allocated: number;
  unallocated: number;
  allocations: InvestmentAllocation[];
}

function assertNonNegativeFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, got ${value}`);
  }
}

function dimensionWeight(dimensions: readonly IndexingDimension[], weights?: Readonly<Record<string, number>>): number {
  if (dimensions.length === 0) return 1;
  return dimensions.reduce((sum, dim) => sum + Math.max(0, weights?.[String(dim)] ?? 1), 0);
}

function proposalWeight(proposal: IndexingContractProposal, policy: InvestmentPolicy): number {
  return proposal.proofScore * dimensionWeight(proposal.dimensions, policy.dimensionWeights);
}

function eligible(proposal: IndexingContractProposal, policy: InvestmentPolicy): boolean {
  return proposal.requestedAmount > 0 && proposal.proofScore >= policy.minProofScore && proposal.bondedAmount >= policy.minBond;
}

/**
 * Allocate an investment/funding tap across eligible indexing contract proposals.
 * Largest-remainder rounding keeps the plan exactly conserved in atomic units.
 */
export function planIndexingInvestmentTap(
  investor: string,
  amount: number,
  proposals: readonly IndexingContractProposal[],
  policy: InvestmentPolicy,
): InvestmentTapPlan {
  if (!investor.trim()) throw new Error("indexing-investment: investor is required");
  assertNonNegativeFinite("amount", amount);
  assertNonNegativeFinite("minProofScore", policy.minProofScore);
  assertNonNegativeFinite("minBond", policy.minBond);

  const candidates = proposals
    .filter((p) => eligible(p, policy))
    .map((p) => ({ proposal: p, weight: proposalWeight(p, policy) }))
    .filter((p) => p.weight > 0);

  if (amount === 0 || candidates.length === 0) {
    return { investor, amount, allocated: 0, unallocated: amount, allocations: [] };
  }

  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  const raw = candidates.map((c) => {
    const exact = Math.min(c.proposal.requestedAmount, (amount * c.weight) / totalWeight);
    return { ...c, exact, base: Math.floor(exact) };
  });

  let assigned = raw.reduce((sum, r) => sum + r.base, 0);
  const eligibleCap = candidates.reduce((sum, c) => sum + Math.max(0, c.proposal.requestedAmount), 0);
  let remaining = Math.min(amount, eligibleCap) - assigned;
  const ordered = [...raw]
    .map((r, i) => ({ i, frac: r.exact - r.base, weight: r.weight, id: r.proposal.contractId }))
    .sort((a, b) => b.frac - a.frac || b.weight - a.weight || a.id.localeCompare(b.id));
  for (const item of ordered) {
    if (remaining <= 0) break;
    const row = raw[item.i]!;
    const add = Math.min(remaining, row.proposal.requestedAmount - row.base);
    if (add <= 0) continue;
    row.base += add;
    remaining -= add;
    assigned += add;
  }

  const allocations = raw
    .filter((r) => r.base > 0)
    .map((r) => ({
      contractId: r.proposal.contractId,
      indexer: r.proposal.indexer,
      amount: r.base,
      weight: r.weight,
      dimensions: r.proposal.dimensions,
      rankEffect: "none" as const,
    }));

  return {
    investor,
    amount,
    allocated: assigned,
    unallocated: amount - assigned,
    allocations,
  };
}
