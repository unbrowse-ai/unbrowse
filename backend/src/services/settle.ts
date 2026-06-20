/**
 * backend/src/services/settle.ts — the settlement / abstention layer that the
 * flat RRF ranking lacks.
 *
 * discovery.ts rrfFuse always returns `slice(0, k)`: it ALWAYS hands back a
 * top result, even when no candidate actually covers the intent. There is no
 * "I don't know" — the top of a bad list looks identical to the top of a good
 * one. This is the coherence atom's complaint: a ranking witness is an ORDERER,
 * not a settlement. Ordering says "this is least-bad"; settlement says "this is
 * GOOD ENOUGH to act on, by quorum, or escalate."
 *
 * settleOrEscalate coordinates on the energy agent's contract (energy.ts):
 *   { energy, witnesses: [a, b], agree }
 * where energy = -score, so a real match settles to a LOWER (negative) energy,
 * and `agree === true` means both witnesses concur on the ranking direction.
 *
 * The rule (two-witness quorum, Deut 19:15): settle the lowest-energy candidate
 * ONLY IF both witnesses concur (`agree`) AND its energy clears the coverage
 * ceiling (energy below `energyCeil`). Otherwise ESCALATE — signal "fall back
 * to browse / I don't know" rather than return a non-covering top result.
 *
 * Bounded: a single pure pass over candidates. No loops, no retries, no
 * re-ticking here — the CALLER owns the bounded-7 escalation walk.
 */

export interface SettleCandidate {
  id: string | number;
  /** energy = -score from energyScore; lower (more negative) = better match. */
  energy: number;
  /** [lexical_witness, dense_witness] — both in [0,1], higher = better. */
  witnesses: [number, number];
  /** Do both witnesses concur on the ranking direction? */
  agree: boolean;
}

export interface SettleOptions {
  /**
   * Minimum number of concurring witnesses required to settle. The energy
   * contract carries exactly two witnesses, so quorum=2 means "both must
   * agree" (the default two-witness rule). quorum>2 can never be met by the
   * 2-witness contract and so forces escalation — by design.
   */
  quorum?: number;
  /**
   * Coverage ceiling on energy. A candidate settles only if its energy is
   * STRICTLY BELOW this. Default 0: since energy = -score and a real match
   * has a positive score, a real match has NEGATIVE energy (< 0). A
   * non-covering candidate (score ~0) sits at energy ~0 and is rejected.
   */
  energyCeil?: number;
}

export type SettleReason = "settled" | "empty" | "no_quorum" | "below_coverage";

export interface SettleResult {
  /** The candidate identity to act on, or null when escalating. */
  settled: { id: string | number } | null;
  /** True iff the caller should fall back to browse / "I don't know". */
  escalate: boolean;
  reason: SettleReason;
}

/**
 * Settle on the lowest-energy candidate when there is a two-witness quorum that
 * it covers the intent; otherwise escalate. Pure, single-pass, bounded.
 */
export function settleOrEscalate(
  candidates: SettleCandidate[],
  opts: SettleOptions = {},
): SettleResult {
  const quorum = opts.quorum ?? 2;
  const energyCeil = opts.energyCeil ?? 0;

  if (candidates.length === 0) {
    return { settled: null, escalate: true, reason: "empty" };
  }

  // Lowest energy = best match (EBM convention). Single pass to find it.
  // A NaN energy is garbage, not a real settlement: NaN compares false against
  // everything, so it can neither be chosen as "best" nor silently block a
  // valid candidate. Skip NaN candidates entirely; on an all-NaN list `best`
  // stays null and we escalate (below_coverage) rather than settle on garbage.
  let best: SettleCandidate | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (Number.isNaN(c.energy)) continue;
    if (best === null || c.energy < best.energy) best = c;
  }
  if (best === null) {
    return { settled: null, escalate: true, reason: "below_coverage" };
  }

  // Two-witness quorum: both witnesses must concur. The contract carries
  // exactly two witnesses; concurrence is `agree`. A quorum demand above the
  // available witness count can never be satisfied and so escalates.
  const concurringWitnesses = best.agree ? best.witnesses.length : 0;
  if (concurringWitnesses < quorum) {
    return { settled: null, escalate: true, reason: "no_quorum" };
  }

  // Coverage gate: the best candidate must actually cover the intent (energy
  // below the ceiling), not merely be the least-bad of a non-covering list.
  if (!(best.energy < energyCeil)) {
    return { settled: null, escalate: true, reason: "below_coverage" };
  }

  return { settled: { id: best.id }, escalate: false, reason: "settled" };
}
