// Revenue split for priced calls (search-on-top, route execution), in basis
// points of the fee. The on-chain settlement is performed by the backend
// (faremeter/Flex); these constants are the CLIENT-VISIBLE breakdown so the CLI/
// SDK can show an honest receipt of where a fee goes. The backend is the source
// of truth for settlement — this mirrors it for display, it does not perform it.
//
// 50 / 35 / 15 — platform / indexer pool / route owner.
export const SPLIT_BPS = {
  platform: 5000,
  indexer: 3500,
  owner: 1500,
} as const;

export const BPS_TOTAL = 10_000;

export type SplitParty = keyof typeof SPLIT_BPS;

export interface SplitBreakdown {
  party: SplitParty;
  bps: number;
  /** Fee share in the smallest unit (e.g. USDC atomic, 6 decimals). */
  amount: number;
}

/**
 * Break a fee (in the smallest unit, e.g. USDC atomic) into the 50/35/15 split
 * for display in a receipt. Largest-remainder rounding so the parts always sum
 * exactly to `feeAtomic` (no rounding drift). Backend settlement is authoritative.
 */
export function computeSplit(feeAtomic: number): SplitBreakdown[] {
  if (!Number.isFinite(feeAtomic) || feeAtomic < 0) {
    throw new RangeError(`feeAtomic must be a non-negative finite number, got ${feeAtomic}`);
  }
  const parties = Object.keys(SPLIT_BPS) as SplitParty[];
  const raw = parties.map((party) => ({
    party,
    bps: SPLIT_BPS[party],
    exact: (feeAtomic * SPLIT_BPS[party]) / BPS_TOTAL,
  }));
  const floored = raw.map((r) => ({ ...r, amount: Math.floor(r.exact) }));
  let remainder = feeAtomic - floored.reduce((s, r) => s + r.amount, 0);
  // distribute the remainder by largest fractional part
  const order = [...floored]
    .map((r, i) => ({ i, frac: raw[i]!.exact - r.amount }))
    .sort((a, b) => b.frac - a.frac);
  for (let n = 0; n < order.length && remainder > 0; n++) {
    floored[order[n]!.i]!.amount += 1;
    remainder -= 1;
  }
  return floored.map(({ party, bps, amount }) => ({ party, bps, amount }));
}
