/**
 * kickstart - revenue-based financing (RBF) with a payback multiple, applied to
 * the unbrowse passive-indexing mesh.
 *
 * Companion to `proof-indexing-economy.ts`. The seeder's stake is a multiplier
 * on the existing `rewardWeights = max(0, stake) * score` formula. A capture
 * pays out from the 35% indexer pool; the seeder takes `rate_bps` of the
 * seeded wallet's portion until cumulative payout hits `payback_multiple *
 * seed`, then the stake expires.
 *
 * Multi-level geometric decay, depth-3 cap, decay factor 4. Anti-pyramid by
 * construction: profit_share requires a real capture_event_id, never an act of
 * signing up more wallets.
 *
 * Pure functions only. No module-level state, no side effects, no I/O. Same
 * inputs always produce the same outputs. The ledger writes happen at the
 * contract-bridge layer, not here.
 */

export interface KickstartTerms {
  /** Stake rate in basis points. Default 500 (5%). Bound: 10–2000 (0.1%–20%). */
  rate_bps: number;
  /** Seed capital in USD. Default 0.10. Bound: 0.001–100. */
  amount_usd: number;
  /** Payback multiple * 100. Default 200 (2x). Bound: 150–500. */
  payback_multiple_x100: number;
  /** Max recursion depth from seeder. Default 3. */
  depth_cap: number;
  /** Geometric decay factor. Default 4. */
  decay_factor: number;
}

export const DEFAULT_KICKSTART_TERMS: KickstartTerms = {
  rate_bps: 500,
  amount_usd: 0.10,
  payback_multiple_x100: 200,
  depth_cap: 3,
  decay_factor: 4,
};

export const BOUND_RATE_BPS = { min: 10, max: 2000 } as const;
export const BOUND_AMOUNT_USD = { min: 0.001, max: 100 } as const;
export const BOUND_PAYBACK_MULTIPLE_X100 = { min: 150, max: 500 } as const;

export interface StakeState {
  kickstart_commitment: string;
  seeder: string;
  seeded: string;
  rate_bps: number;
  payback_target_usd: number;
  cumulative_payout_usd: number;
  status: "active" | "expired" | "revoked";
  expired_at: number | null;
  created_at: number;
}

export interface ProfitShareResult {
  capture_event_id: string;
  capture_revenue_usd: number;
  seeder_take_usd: number;
  seeded_keeps_usd: number;
  cumulative_after_usd: number;
  remaining_to_payback_usd: number;
  stake_expired: boolean;
}

export interface KickstartRowInput {
  seeder: string;
  seeded: string;
  amount_usd: number;
  rate_bps: number;
  payback_multiple_x100: number;
  depth_cap: number;
  decay_factor: number;
  ts: number;
}

/** Validate a KickstartTerms against the bounds. Returns null on valid, else an error string. */
export function validateTerms(t: Partial<KickstartTerms>): string | null {
  if (t.rate_bps !== undefined && (t.rate_bps < BOUND_RATE_BPS.min || t.rate_bps > BOUND_RATE_BPS.max)) {
    return `rate_bps ${t.rate_bps} out of bounds [${BOUND_RATE_BPS.min}, ${BOUND_RATE_BPS.max}]`;
  }
  if (t.amount_usd !== undefined && (t.amount_usd < BOUND_AMOUNT_USD.min || t.amount_usd > BOUND_AMOUNT_USD.max)) {
    return `amount_usd ${t.amount_usd} out of bounds [${BOUND_AMOUNT_USD.min}, ${BOUND_AMOUNT_USD.max}]`;
  }
  if (
    t.payback_multiple_x100 !== undefined &&
    (t.payback_multiple_x100 < BOUND_PAYBACK_MULTIPLE_X100.min || t.payback_multiple_x100 > BOUND_PAYBACK_MULTIPLE_X100.max)
  ) {
    return `payback_multiple_x100 ${t.payback_multiple_x100} out of bounds [${BOUND_PAYBACK_MULTIPLE_X100.min}, ${BOUND_PAYBACK_MULTIPLE_X100.max}]`;
  }
  return null;
}

/** Compute the payback target from seed amount and multiple. */
export function paybackTarget(amount_usd: number, payback_multiple_x100: number): number {
  return amount_usd * (payback_multiple_x100 / 100);
}

/**
 * The seeder's take rate effectiveness at a given recursion depth.
 * depth=0 → full stake rate (B's stake on C, B staked C directly).
 * depth=1 → rate / decay_factor (B's geometric decay on D, who C staked).
 * depth>=depth_cap → 0 (cap reached).
 *
 * depth_from_seeder counts kickstart edges from seeder to the wallet whose
 * capture is being sliced. depth=0 is "the wallet I directly seeded".
 */
export function geometricDecayRate(rate_bps: number, depth: number, decay_factor: number, depth_cap: number): number {
  if (depth < 0 || depth >= depth_cap) return 0;
  return rate_bps / Math.pow(decay_factor, depth);
}

/**
 * Compute a single capture event's profit-share for one stake edge.
 *
 * Pure function of (capture_revenue, stake state, terms). No mutation; returns
 * a new ProfitShareResult. Caller is responsible for appending a
 * `contract:profit_share` row to the ledger and updating the parent
 * `contract:stake` row's cumulative_payout_usd + status if `stake_expired`.
 *
 * Returns `{ seeder_take_usd: 0, ... stake_expired: true }` when the stake is
 * already expired or revoked — never a negative take, never take past the
 * payback target.
 */
export function kickstartPayout(
  stake: StakeState,
  capture_revenue_usd: number,
  capture_event_id: string,
  ts: number,
): ProfitShareResult {
  if (stake.status !== "active") {
    return {
      capture_event_id,
      capture_revenue_usd,
      seeder_take_usd: 0,
      seeded_keeps_usd: capture_revenue_usd,
      cumulative_after_usd: stake.cumulative_payout_usd,
      remaining_to_payback_usd: Math.max(0, stake.payback_target_usd - stake.cumulative_payout_usd),
      stake_expired: true,
    };
  }

  const remaining = Math.max(0, stake.payback_target_usd - stake.cumulative_payout_usd);
  if (remaining <= 0) {
    // Defensive: stake should have been marked expired already.
    return {
      capture_event_id,
      capture_revenue_usd,
      seeder_take_usd: 0,
      seeded_keeps_usd: capture_revenue_usd,
      cumulative_after_usd: stake.cumulative_payout_usd,
      remaining_to_payback_usd: 0,
      stake_expired: true,
    };
  }

  const raw_take = (capture_revenue_usd * stake.rate_bps) / 10_000;
  const seeder_take_usd = Math.min(raw_take, remaining);
  const seeded_keeps_usd = capture_revenue_usd - seeder_take_usd;
  const cumulative_after_usd = stake.cumulative_payout_usd + seeder_take_usd;
  const stake_expired = cumulative_after_usd >= stake.payback_target_usd;

  return {
    capture_event_id,
    capture_revenue_usd,
    seeder_take_usd,
    seeded_keeps_usd,
    cumulative_after_usd,
    remaining_to_payback_usd: Math.max(0, stake.payback_target_usd - cumulative_after_usd),
    stake_expired,
  };
}

/**
 * Apply a ProfitShareResult to a StakeState, returning a new StakeState.
 * Pure: does not mutate input. Caller writes the new state to the ledger.
 */
export function applyPayout(stake: StakeState, result: ProfitShareResult, ts: number): StakeState {
  if (stake.status !== "active") return stake;
  return {
    ...stake,
    cumulative_payout_usd: result.cumulative_after_usd,
    status: result.stake_expired ? "expired" : "active",
    expired_at: result.stake_expired ? ts : stake.expired_at,
  };
}

/**
 * Worst-case captured-wallet take rate when all upstream stakes are active.
 *
 * For a wallet with N upstream seeders in a chain (B → C → D → wallet), where
 * each upstream seeder's stake rate is `rate_bps` and decay factor is `f`:
 *   wallet_keeps_bps = 10000 - rate_bps - rate_bps/f - rate_bps/f^2 - ... - rate_bps/f^(N-1)
 *
 * For default terms (5%, factor 4, depth 3): wallet keeps ≥ 9343.75 bps.
 */
export function worstCaseWalletKeepBps(terms: KickstartTerms): number {
  let upstream_take_bps = 0;
  for (let depth = 0; depth < terms.depth_cap; depth++) {
    upstream_take_bps += geometricDecayRate(terms.rate_bps, depth, terms.decay_factor, terms.depth_cap);
  }
  return Math.max(0, 10_000 - upstream_take_bps);
}

/**
 * Tracker aggregates. Pure functions of an array of StakeState + the
 * kickstart rows that produced them. Returns the numbers the /contract +
 * /lewis-brain tracker renders as the convergence report.
 */
export interface KickstartTrackerAggregates {
  seeded_wallets_total: number;
  seed_capital_deployed_usd: number;
  profit_returned_to_seeders_usd: number;
  recovered_capital_usd: number;
  pending_payback_usd: number;
  dead_wood_count: number;
  dead_wood_rate: number;
  active_stakes: number;
  expired_stakes: number;
  revoked_stakes: number;
}

export function trackerAggregates(stakes: StakeState[]): KickstartTrackerAggregates {
  const seededWallets = new Set<string>();
  let seedCapital = 0;
  let profitReturned = 0;
  let recoveredCapital = 0;
  let pendingPayback = 0;
  let deadWood = 0;
  let active = 0;
  let expired = 0;
  let revoked = 0;

  for (const s of stakes) {
    seededWallets.add(s.seeded);
    // Reconstruct seed capital from payback target (target = amount * multiple, so amount = target / multiple).
    // The tracker doesn't carry the original multiple in the StakeState shape, so we approximate by
    // using the target / 2 (the default 2x). A more precise tracker reads the parent KickstartRow from the ledger.
    // For now we accept the approximation; the ledger read in the contract-bridge layer can supply exact amounts.
    seedCapital += s.payback_target_usd / 2; // approx — see comment.
    profitReturned += s.cumulative_payout_usd;
    if (s.status === "expired") {
      recoveredCapital += s.payback_target_usd;
      expired++;
    } else if (s.status === "active") {
      pendingPayback += Math.max(0, s.payback_target_usd - s.cumulative_payout_usd);
      active++;
      if (s.cumulative_payout_usd === 0) deadWood++;
    } else if (s.status === "revoked") {
      revoked++;
    }
  }

  const total = active + expired + revoked;
  return {
    seeded_wallets_total: seededWallets.size,
    seed_capital_deployed_usd: seedCapital,
    profit_returned_to_seeders_usd: profitReturned,
    recovered_capital_usd: recoveredCapital,
    pending_payback_usd: pendingPayback,
    dead_wood_count: deadWood,
    dead_wood_rate: total === 0 ? 0 : deadWood / total,
    active_stakes: active,
    expired_stakes: expired,
    revoked_stakes: revoked,
  };
}

/**
 * The lewis-brain verdict on the kickstart's convergence.
 *
 * Witness 1: dead_wood_rate < 0.5 — most seeded wallets have at least one
 * capture event (mechanical, from the ledger).
 *
 * Witness 2: a separate fdry_acc_attr_mesh_usd input (computed by the
 * contract-bridge layer, not here, since it requires reading paid-execute
 * events). When provided, must exceed seed_capital_deployed_usd for the
 * flywheel to be net-positive.
 *
 * Returns one of: "witnessed" | "incremental" | "unwitnessed-feeling". The
 * honest HOLD beats a forced green.
 */
export function trackerVerdict(
  aggregates: KickstartTrackerAggregates,
  fdry_acc_attr_mesh_usd: number | null,
): "witnessed" | "incremental" | "unwitnessed-feeling" {
  const w1 = aggregates.dead_wood_rate < 0.5;
  const w2 = fdry_acc_attr_mesh_usd !== null && fdry_acc_attr_mesh_usd > aggregates.seed_capital_deployed_usd;
  if (w1 && w2) return "witnessed";
  if (w1 && !w2) return "incremental";
  return "unwitnessed-feeling";
}
