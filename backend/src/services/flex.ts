/**
 * Flex split arithmetic + authorization assembly (Day 3 seed, v6.16.0).
 *
 * `computeFlexSplits` is REAL today — pure arithmetic over a SkillManifest's
 * contributor list. Locks the splits contract so Day-4 regressions trip the
 * test. `buildFlexAuthorization` is a STUB; Day 4 wires it against
 * @faremeter/flex-solana (cross-referenced: SplitEntry from
 * /tmp/flex-probe/.../generated/types/splitEntry.d.ts — { recipient: Address;
 * bps: number }).
 */

import type { SkillManifest } from "../types.js";

export interface FlexSplit {
  recipient: string;  // SPL token account (USDC ATA) of recipient
  bps: number;        // basis points, summing to 10000
}

export interface FlexAuthorizationDraft {
  escrow: string;
  mint: string;
  maxAmount: string;
  authorizationId: string;
  expiresAtSlot: string;
  splits: FlexSplit[];
}

// 1000 bps = 10%. Platform always present.
export const PLATFORM_BPS = 1000;
export const FLEX_MAX_SPLITS = 5;

/**
 * Real implementation today: pure arithmetic.
 * Computes recipient splits summing to 10000 bps.
 * - Platform always included at PLATFORM_BPS (1000).
 * - Contributors share the remaining 9000 bps weighted by cumulative_delta.
 * - Up to FLEX_MAX_SPLITS (5) entries.
 * - Returns empty array if no payable contributor (caller must handle).
 */
export function computeFlexSplits(
  skill: Pick<SkillManifest, "contributors">,
  platformRecipient: string,
): FlexSplit[] {
  const payable = (skill.contributors ?? []).filter((c) => c.wallet_address?.trim());
  if (payable.length === 0) return [];

  // Top contributors only — cap at (FLEX_MAX_SPLITS - 1) to leave room for platform.
  const sorted = [...payable].sort((a, b) => b.cumulative_delta - a.cumulative_delta);
  const eligible = sorted.slice(0, FLEX_MAX_SPLITS - 1);

  const totalDelta = eligible.reduce((s, c) => s + Math.max(c.cumulative_delta, 0.01), 0);
  const contributorPool = 10000 - PLATFORM_BPS;  // 9000 bps for contributors

  const contributorSplits: FlexSplit[] = eligible.map((c) => {
    const weight = Math.max(c.cumulative_delta, 0.01) / totalDelta;
    return {
      recipient: c.wallet_address!.trim(),  // TODO Day-4: this should be the USDC ATA, not the wallet address
      bps: Math.max(1, Math.round(weight * contributorPool)),
    };
  });

  // Normalize so contributor shares sum to exactly 9000 bps
  const totalContributorBps = contributorSplits.reduce((s, c) => s + c.bps, 0);
  if (totalContributorBps !== contributorPool && contributorSplits.length > 0) {
    contributorSplits.sort((a, b) => b.bps - a.bps);
    contributorSplits[0].bps += contributorPool - totalContributorBps;
  }

  return [
    { recipient: platformRecipient, bps: PLATFORM_BPS },
    ...contributorSplits,
  ];
}

/**
 * Stub on Day 3 — Day 4 wires escrow PDA derivation + authorizationId generation.
 */
export async function buildFlexAuthorization(
  _opts: {
    agentEscrow: string;
    mint: string;
    maxAmountUc: bigint;
    splits: FlexSplit[];
    currentSlot: bigint;
    refundTimeoutSlots: bigint;
  },
): Promise<FlexAuthorizationDraft> {
  throw new Error("not yet implemented (Day 4) — needs @faremeter/flex-solana wiring");
}
