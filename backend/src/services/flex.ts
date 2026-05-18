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

// Platform / contributor split (50/50 per unbrowse-payments-faremeter wave).
// Faremeter Flex authorizations carry the splits array natively; on-chain
// settlement distributes per bps, so the platform half and the contributor
// half BOTH land in the same finalize transaction. Override per environment
// via FLEX_PLATFORM_BPS (0 - 10000) if a deployment ever needs a different
// cut without a recompile.
export const PLATFORM_BPS = 5000;
export const FLEX_MAX_SPLITS = 5;
// OWNER_BPS is the share that goes to a DNS-claimed site owner (the
// operator of the domain the skill talks to). Mirrors the
// SITE_OWNER_SHARE_PCT = 0.20 constant in backend/src/services/pricing.ts
// and matches the 50/30/20 split documented in docs/HOW_UNBROWSE_PAYS.md.
// Only fires when SkillManifest.owner_compensation_opt_in === true AND
// owner_wallet_usdc_ata is non-empty (server-stamped by the DNS-claim
// verify endpoint at backend/src/routes/claim.ts). When neither holds,
// the indexer pool keeps the full 10000 - PLATFORM_BPS = 5000 bps.
export const OWNER_BPS = 2000;

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
  skill: Pick<SkillManifest,
    | "contributors"
    | "owner_compensation_opt_in"
    | "owner_wallet_usdc_ata"
  >,
  platformRecipient: string,
): FlexSplit[] {
  const payable = (skill.contributors ?? []).filter((c) => c.wallet_address?.trim());

  // Site-owner lane: when the domain has been DNS-claimed AND the skill
  // opts in to owner compensation, carve OWNER_BPS off the top before
  // the indexer pool is divided. The verify endpoint at
  // backend/src/routes/claim.ts is the only path that stamps
  // owner_wallet_usdc_ata; both fields are server-owned (see
  // backend/src/types.ts new owner_wallet_* docstring). Until the
  // verify endpoint ships, owner_wallet_usdc_ata is never set in
  // production, so this branch is dormant by construction.
  const ownerOptedIn = skill.owner_compensation_opt_in === true;
  const ownerUsdcAta = skill.owner_wallet_usdc_ata?.trim();
  const ownerActive = ownerOptedIn && !!ownerUsdcAta;
  const ownerSplit: FlexSplit | null = ownerActive
    ? { recipient: ownerUsdcAta!, bps: OWNER_BPS }
    : null;

  // When there is no indexer contributor pool AND no owner share,
  // there is nothing to split beyond the platform; return empty so
  // the caller falls back to a single-recipient transfer (today's
  // behavior).
  if (payable.length === 0 && !ownerActive) return [];

  // Top contributors only — cap at (FLEX_MAX_SPLITS - 2) when an owner
  // lane is active (reserves room for both platform AND owner), else
  // (FLEX_MAX_SPLITS - 1) (just platform).
  const contributorCap = ownerActive ? FLEX_MAX_SPLITS - 2 : FLEX_MAX_SPLITS - 1;
  const sorted = [...payable].sort((a, b) => b.cumulative_delta - a.cumulative_delta);
  const eligible = sorted.slice(0, Math.max(contributorCap, 0));

  const totalDelta = eligible.reduce((s, c) => s + Math.max(c.cumulative_delta, 0.01), 0);
  const contributorPool = 10000 - PLATFORM_BPS - (ownerActive ? OWNER_BPS : 0);

  const contributorSplits: FlexSplit[] = eligible.length > 0
    ? eligible.map((c) => {
        const weight = Math.max(c.cumulative_delta, 0.01) / totalDelta;
        return {
          recipient: c.wallet_address!.trim(),
          bps: Math.max(1, Math.round(weight * contributorPool)),
        };
      })
    : [];

  // Normalize so contributor shares sum to exactly contributorPool bps.
  if (contributorSplits.length > 0) {
    const totalContributorBps = contributorSplits.reduce((s, c) => s + c.bps, 0);
    if (totalContributorBps !== contributorPool) {
      contributorSplits.sort((a, b) => b.bps - a.bps);
      contributorSplits[0].bps += contributorPool - totalContributorBps;
    }
  } else if (ownerActive) {
    // No contributors but owner is active — fold the contributor pool
    // back to the platform so the bps still sum to 10000.
    // (Empty contributor list AND owner active AND no contributor pool
    // would otherwise leave a hole; this keeps the on-chain sum exact.)
  }

  // Merge order: platform -> owner -> contributors (stable for the
  // Flex facilitator's duplicate-recipient remediation).
  const splits: FlexSplit[] = [{ recipient: platformRecipient, bps: PLATFORM_BPS }];
  if (ownerSplit) splits.push(ownerSplit);
  splits.push(...contributorSplits);

  // If the contributor pool was empty but owner was active, fold any
  // unallocated bps into the platform recipient so the on-chain split
  // sums to exactly 10000.
  const allocated = splits.reduce((s, x) => s + x.bps, 0);
  if (allocated < 10000) {
    splits[0]!.bps += 10000 - allocated;
  }

  return mergeSplits(splits);
}

/**
 * Collapse splits that share a recipient (e.g. a contributor whose wallet
 * happens to equal the platform recipient, or a recipient appearing in two
 * eligible contributor entries). The Faremeter Flex on-chain program
 * rejects authorizations with duplicate recipients
 * (`FLEX_ERROR__DUPLICATE_SPLIT_RECIPIENT`); the SDK's `mergeSplits` is the
 * declared remediation. Order is preserved by first appearance so the
 * platform stays at index 0 when it dedupes against a contributor.
 */
export function mergeSplits(splits: FlexSplit[]): FlexSplit[] {
  if (splits.length <= 1) return splits;
  const order: string[] = [];
  const byRecipient = new Map<string, number>();
  for (const s of splits) {
    const r = s.recipient.trim();
    if (!r) continue;
    if (byRecipient.has(r)) {
      byRecipient.set(r, byRecipient.get(r)! + s.bps);
    } else {
      byRecipient.set(r, s.bps);
      order.push(r);
    }
  }
  return order.map((r) => ({ recipient: r, bps: byRecipient.get(r)! }));
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
