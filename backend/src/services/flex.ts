/**
 * Flex split arithmetic + authorization assembly (Day 4, v6.16.0).
 *
 * `computeFlexSplits` — pure arithmetic over a SkillManifest's contributor list.
 * `buildFlexAuthorization` — pure assembly + validation, NO Solana RPC. Day 5
 * wires the facilitator's submit path that consumes this draft.
 *
 * Cross-references in the probe dir confirm the shape:
 *   /tmp/flex-probe/.../flex-solana/dist/src/authorization.d.ts ::
 *     SerializePaymentAuthorizationArgs { programId, escrow, mint, maxAmount,
 *       authorizationId, expiresAtSlot, splits: SplitInput[] }
 *   /tmp/flex-probe/.../flex-solana/dist/src/types.d.ts ::
 *     FlexSplitEntry { recipient: string; bps: number }
 */

import type { Env, SkillManifest } from "../types.js";
import { flexRefundTimeoutSlots } from "./flex-facilitator.js";

export interface FlexSplit {
  recipient: string;  // SPL token account (USDC ATA) of recipient
  bps: number;        // basis points, summing to 10000
}

export interface FlexAuthorizationDraft {
  escrow: string;
  mint: string;
  maxAmount: string;       // µ¢ (USDC has 6 decimals) — string-serialized bigint
  authorizationId: string; // u64 — string-serialized bigint
  expiresAtSlot: string;   // string-serialized bigint
  splits: FlexSplit[];
}

// 1000 bps = 10%. Platform always present.
export const PLATFORM_BPS = 1000;
export const FLEX_MAX_SPLITS = 5;

// Mainnet USDC. Devnet/test override happens via the facilitator service in
// Day-5, not here — this module is pure assembly.
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Real implementation: pure arithmetic.
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
      recipient: c.wallet_address!.trim(),  // TODO Day-5: this should be the USDC ATA, not the wallet address
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
 * Assemble + validate a Flex authorization draft.
 *
 * Pure assembly. NO Solana RPC, NO signing. The caller is responsible for
 * fetching `currentSlot` from RPC. Day-5 (facilitator path) consumes the draft
 * and feeds it to `serializePaymentAuthorization` + `signPaymentAuthorization`
 * from `@faremeter/flex-solana`.
 *
 * Validation:
 *  - splits non-empty
 *  - splits sum to exactly 10000 bps
 *  - splits count ≤ FLEX_MAX_SPLITS (5)
 *  - maxAmountUc must be ≥ 1
 */
export async function buildFlexAuthorization(
  env: Env,
  opts: {
    agentEscrow: string;
    maxAmountUc: bigint;
    splits: FlexSplit[];
    currentSlot: bigint;
  },
): Promise<FlexAuthorizationDraft> {
  if (opts.splits.length === 0) {
    throw new Error("buildFlexAuthorization: empty splits");
  }
  if (opts.splits.length > FLEX_MAX_SPLITS) {
    throw new Error(
      `buildFlexAuthorization: more than ${FLEX_MAX_SPLITS} splits (got ${opts.splits.length})`,
    );
  }
  const totalBps = opts.splits.reduce((s, e) => s + e.bps, 0);
  if (totalBps !== 10000) {
    throw new Error(`buildFlexAuthorization: splits bps sum ${totalBps} != 10000`);
  }
  if (opts.maxAmountUc < 1n) {
    throw new Error(`buildFlexAuthorization: maxAmountUc must be >= 1 (got ${opts.maxAmountUc})`);
  }
  if (!opts.agentEscrow.trim()) {
    throw new Error("buildFlexAuthorization: agentEscrow required");
  }

  // Generate authorizationId — random u64 as base10 string. crypto.getRandomValues
  // is available in Workers + Bun. We pack 8 bytes big-endian into a bigint.
  const idBytes = new Uint8Array(8);
  crypto.getRandomValues(idBytes);
  let id = 0n;
  for (let i = 0; i < 8; i++) id = (id << 8n) | BigInt(idBytes[i]!);
  const authorizationId = id.toString(10);

  const refundTimeout = flexRefundTimeoutSlots(env);
  const expiresAtSlot = (opts.currentSlot + refundTimeout).toString(10);

  return {
    escrow: opts.agentEscrow,
    mint: USDC_MINT_MAINNET,
    maxAmount: opts.maxAmountUc.toString(10),
    authorizationId,
    expiresAtSlot,
    splits: opts.splits,
  };
}
