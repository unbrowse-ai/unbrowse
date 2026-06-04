/**
 * bond-challenge — collateralised accountability (Paper 3 §"Bonding, challenge,
 * and slashing: the collateralised-accountability [layer]"; arXiv:2604.00694
 * maintenance-network companion).
 *
 * Freshness is only trustworthy if a false freshness-claim is *costly*. A
 * maintainer bonds collateral to become eligible to publish proofs of indexing.
 * Anyone may challenge a proof by re-indexing the live source; if the proof's
 * committed schema has diverged from live (proof-of-indexing.proofDiverged ===
 * true) the proof was "stale-but-confident" — the worst failure — and the
 * maintainer's bond is slashed: part rewards the challenger (the incentive to
 * police), the rest is burned (so policing is not a profit pump).
 *
 * Doctrine (cited): bonding buys *eligibility and credibility, never ranking*
 * (Paper 3 §Settle). `isEligible` is the only thing a bond gates here — no score,
 * no rank. Economic policy (min bond, penalty, reward split) is INJECTED, never
 * hardcoded, so no economic constant lives in this surface (leak-guard clean).
 *
 * Pure + deterministic. The on-chain escrow that actually holds and moves the
 * USDC bond is the remaining boundary (settles over the existing x402/Flex rail);
 * this module is the verifiable state machine that *decides* bond/slash.
 */
// cross: sha256:b35fea21e179afd6de983a90f4c1575527619b2d0143edd7d31b0dd70d8a97f5  (the route code inherits the root signature — pointer not payload; verify via (internal))
import { proofDiverged, type ProofOfIndexing } from "./proof-of-indexing.js";

/** A maintainer's posted collateral. Additive across bonds. */
export interface Bond {
	maintainer: string;
	amount: number; // atomic units (e.g. micro-USDC); unit is the caller's, not ours
	bondedAt: number; // ms-epoch of the most recent bond top-up
}

/** Injected economic policy — no constant baked into this surface. */
export interface BondPolicy {
	/** minimum bonded collateral to be eligible to publish proofs. */
	minBond: number;
	/** collateral slashed when a challenge is upheld (capped at the bond). */
	penalty: number;
	/** basis points of the slashed amount paid to the challenger; remainder burned. */
	challengerRewardBps: number;
}

/** Outcome of resolving a challenge against a proof. */
export type ChallengeVerdict =
	| {
			outcome: "upheld"; // the proof lied — live schema diverged
			diverged: true;
			slashed: number;
			challengerReward: number;
			burned: number;
			maintainerRemaining: number;
	  }
	| {
			outcome: "dismissed"; // the proof held — live still matches
			diverged: false;
	  };

/**
 * BondLedger — maintainer → bonded collateral. In-memory by design (mirrors
 * DiscoveryLedger / ProofChain); the durable + on-chain copy is the escrow.
 */
export class BondLedger {
	private readonly bonds = new Map<string, Bond>();

	/** Post (or top up) collateral. Returns the maintainer's new total bond. */
	bond(maintainer: string, amount: number, at: number): Bond {
		if (amount <= 0) throw new Error("bond-challenge: bond amount must be positive");
		const existing = this.bonds.get(maintainer);
		const next: Bond = {
			maintainer,
			amount: (existing?.amount ?? 0) + amount,
			bondedAt: at,
		};
		this.bonds.set(maintainer, next);
		return next;
	}

	/** Currently bonded collateral for a maintainer (0 if none). */
	bondedAmount(maintainer: string): number {
		return this.bonds.get(maintainer)?.amount ?? 0;
	}

	/**
	 * Eligibility to publish proofs — the ONLY thing a bond gates. It is a
	 * boolean threshold, never a score: more bond does NOT buy more rank
	 * (Paper 3 doctrine). A caller wiring this into ranking is a bug.
	 */
	isEligible(maintainer: string, policy: BondPolicy): boolean {
		return this.bondedAmount(maintainer) >= policy.minBond;
	}

	/**
	 * Move `penalty` out of a maintainer's bond (capped at their balance).
	 * Returns the amount actually slashed and the remaining bond.
	 */
	slash(maintainer: string, penalty: number): { slashed: number; remaining: number } {
		const bal = this.bondedAmount(maintainer);
		const slashed = Math.min(Math.max(penalty, 0), bal);
		const remaining = bal - slashed;
		const existing = this.bonds.get(maintainer);
		if (existing) existing.amount = remaining;
		return { slashed, remaining };
	}
}

/**
 * Resolve a challenge: re-index the live source, compare to the challenged
 * proof, and (if diverged) slash the maintainer's bond. The divergence test is
 * the SAME falsifiable fact `proof-of-indexing` exposes — the two modules
 * corroborate (two witnesses, ): one builds the claim, the other
 * adjudicates it.
 *
 * Slashed collateral splits per injected policy: `challengerRewardBps` to the
 * challenger, the remainder burned — policing is incentivised but not a pump.
 */
export async function resolveChallenge(
	proof: ProofOfIndexing,
	liveResponse: unknown,
	ledger: BondLedger,
	policy: BondPolicy,
): Promise<ChallengeVerdict> {
	const diverged = await proofDiverged(proof, liveResponse);
	if (!diverged) {
		return { outcome: "dismissed", diverged: false };
	}
	const { slashed, remaining } = ledger.slash(proof.indexer, policy.penalty);
	const challengerReward = Math.floor((slashed * policy.challengerRewardBps) / 10_000);
	const burned = slashed - challengerReward;
	return {
		outcome: "upheld",
		diverged: true,
		slashed,
		challengerReward,
		burned,
		maintainerRemaining: remaining,
	};
}
