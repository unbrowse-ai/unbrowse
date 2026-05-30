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

/**
 * Role tag for a FlexSplit entry. Off-chain only — the Flex on-chain
 * program consumes `{ recipient, bps }` and ignores extra fields, so this
 * tag is preserved for journal rows / API responses without changing the
 * settlement contract. Roles follow the paper's $F = C + M + I + T$
 * partition (arXiv 2604.00694 §3.5) plus the site-owner carve-out from
 * §3.6.
 *
 * - `infrastructure` — platform toll (paper $I$, ~10%); always present.
 * - `site_owner`     — opted-in site owner share (§3.6); present when
 *                      owner_compensation_opt_in && owner_wallet_usdc_ata.
 * - `contributor`    — delta-attributed contributor share (paper $C$);
 *                      one entry per payable contributor.
 * - `maintainer`     — validator share (paper $M$); present when
 *                      MAINTAINER_BPS > 0 and a maintainer wallet binds.
 * - `treasury`       — network reserve (paper $T$); present when
 *                      TREASURY_BPS > 0 and a treasury wallet binds.
 *
 * Contract organ 98973c11 stage G3 (264c3841).
 */
export type FlexSplitRole = "infrastructure" | "site_owner" | "contributor" | "maintainer" | "treasury";

export interface FlexSplit {
  recipient: string;  // SPL token account (USDC ATA) of recipient
  bps: number;        // basis points, summing to 10000
  /**
   * Optional role tag (G3) — off-chain semantic label so journal readers
   * and admin endpoints can audit the deployed split against the paper's
   * partition. Absence is backwards-compatible; the on-chain program
   * never sees this field.
   */
  role?: FlexSplitRole;
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
// Per-skill markup_bps clamp range (Pontus / ABK Labs 2026-05-21 brief:
// "5-80% markup potential on Flex"). When SkillManifest.markup_bps is
// set, computeFlexSplits coerces it into this range before using it as
// the effective platform cut. Out-of-range values are clamped (not
// rejected) so a misconfigured skill still settles cleanly at the
// nearest bound. PLATFORM_BPS (5000) is the default when markup_bps is
// unset; it sits inside [MARKUP_BPS_MIN, MARKUP_BPS_MAX] by design.
export const MARKUP_BPS_MIN = 500;
export const MARKUP_BPS_MAX = 8000;

// operator of the domain the skill talks to). Mirrors the
// SITE_OWNER_SHARE_PCT = 0.15 constant in backend/src/services/pricing.ts
// and matches the 50/35/15 split documented in docs/HOW_UNBROWSE_PAYS.md.
// Only fires when SkillManifest.owner_compensation_opt_in === true AND
// owner_wallet_usdc_ata is non-empty (server-stamped by the DNS-claim
// verify endpoint at backend/src/routes/claim.ts). When neither holds,
// the indexer pool keeps the full 10000 - PLATFORM_BPS = 5000 bps.
export const OWNER_BPS = 1500;

// Maintainer + treasury shares (paper §3.5 $F = C + M + I + T$). Default
// 0 today — the structure is wired so off-chain readers can audit the
// 5-role partition (G3), but maintainer / treasury recipients are not
// yet bound on production. When the env vars MAINTAINER_WALLET_ADDRESS
// and TREASURY_WALLET_ADDRESS get set with real USDC ATAs, a deploy
// can dial these up without further code change. Each carries an
// (env -> constant) override knob so a deployment can rebalance
// without a recompile.
//
// Backwards-compatibility: with both set to 0, computeFlexSplits emits
// exactly the splits it emitted before G3. The 5-role partition is
// activated only when MAINTAINER_BPS > 0 || TREASURY_BPS > 0 AND the
// corresponding wallet env var is set.
export const MAINTAINER_BPS_DEFAULT = 0;
export const TREASURY_BPS_DEFAULT = 0;

// Mainnet USDC. Devnet/test override happens via the facilitator service in
// Day-5, not here — this module is pure assembly.
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/**
 * Real implementation: pure arithmetic.
 * Computes recipient splits summing to 10000 bps.
 * - Platform always included at PLATFORM_BPS (5000).
 * - Contributors share the remaining 5000 bps weighted by cumulative_delta.
 * - Up to FLEX_MAX_SPLITS (5) entries.
 * - Returns empty array if no payable contributor (caller must handle).
 */
/**
 * Optional 5-role partition inputs (G3, contract organ 98973c11). When
 * `maintainer_bps > 0` AND `maintainer_recipient` is set, a maintainer
 * split is emitted. Same for treasury. Both default to 0 / unset, so
 * passing nothing reproduces today's 3-role behaviour (platform +
 * site-owner + contributors) byte-for-byte.
 */
export interface FlexSplitRoleConfig {
  maintainer_bps?: number;
  maintainer_recipient?: string;
  treasury_bps?: number;
  treasury_recipient?: string;
}

export function computeFlexSplits(
  skill: Pick<SkillManifest,
    | "contributors"
    | "owner_compensation_opt_in"
    | "owner_wallet_usdc_ata"
    | "markup_bps"
  >,
  platformRecipient: string,
  roleConfig?: FlexSplitRoleConfig,
): FlexSplit[] {
  // Per-skill markup override (Pontus / ABK Labs 2026-05-21 brief).
  // Clamp before using so a misconfigured skill still produces a
  // valid split rather than throwing or settling at 0% to platform.
  // Negative / non-finite / non-integer values fall back to the
  // default PLATFORM_BPS; integer values get clamped to the
  // [MARKUP_BPS_MIN, MARKUP_BPS_MAX] range.
  const requestedMarkup = skill.markup_bps;
  const effectivePlatformBps =
    typeof requestedMarkup === "number" && Number.isFinite(requestedMarkup) && requestedMarkup > 0
      ? Math.min(MARKUP_BPS_MAX, Math.max(MARKUP_BPS_MIN, Math.round(requestedMarkup)))
      : PLATFORM_BPS;

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
    ? { recipient: ownerUsdcAta!, bps: OWNER_BPS, role: "site_owner" }
    : null;

  // G3 — maintainer + treasury lanes (paper §3.5 $F = C + M + I + T$).
  // Both default to 0 / unset; activation requires BOTH a non-zero bps
  // AND a recipient wallet (passed via roleConfig, derived from
  // MAINTAINER_WALLET_ADDRESS / TREASURY_WALLET_ADDRESS at the call
  // site). Clamped to [0, 10000] in case env vars carry garbage.
  const maintainerBpsRaw = Math.round(roleConfig?.maintainer_bps ?? MAINTAINER_BPS_DEFAULT);
  const maintainerBps = Math.min(10000, Math.max(0, Number.isFinite(maintainerBpsRaw) ? maintainerBpsRaw : 0));
  const maintainerRecipient = roleConfig?.maintainer_recipient?.trim();
  const maintainerActive = maintainerBps > 0 && !!maintainerRecipient;
  const maintainerSplit: FlexSplit | null = maintainerActive
    ? { recipient: maintainerRecipient!, bps: maintainerBps, role: "maintainer" }
    : null;

  const treasuryBpsRaw = Math.round(roleConfig?.treasury_bps ?? TREASURY_BPS_DEFAULT);
  const treasuryBps = Math.min(10000, Math.max(0, Number.isFinite(treasuryBpsRaw) ? treasuryBpsRaw : 0));
  const treasuryRecipient = roleConfig?.treasury_recipient?.trim();
  const treasuryActive = treasuryBps > 0 && !!treasuryRecipient;
  const treasurySplit: FlexSplit | null = treasuryActive
    ? { recipient: treasuryRecipient!, bps: treasuryBps, role: "treasury" }
    : null;

  // When there is no indexer contributor pool AND no owner share AND
  // no G3 maintainer / treasury lane, there is nothing to split beyond
  // the platform; return empty so the caller falls back to a single-
  // recipient transfer (today's behavior). G3 lanes count as a reason
  // to emit a multi-recipient split even when contributors / owner
  // are empty.
  if (payable.length === 0 && !ownerActive && !maintainerActive && !treasuryActive) return [];

  // Top contributors only — cap at (FLEX_MAX_SPLITS - reservedSlots)
  // where reservedSlots = 1 (platform) + owner + maintainer + treasury
  // when each lane is active. The Faremeter Flex program caps splits at
  // FLEX_MAX_SPLITS=5; G3 lanes consume slots in the same budget.
  const reservedSlots = 1 + (ownerActive ? 1 : 0) + (maintainerActive ? 1 : 0) + (treasuryActive ? 1 : 0);
  const contributorCap = FLEX_MAX_SPLITS - reservedSlots;
  const sorted = [...payable].sort((a, b) => b.cumulative_delta - a.cumulative_delta);
  const eligible = sorted.slice(0, Math.max(contributorCap, 0));

  const totalDelta = eligible.reduce((s, c) => s + Math.max(c.cumulative_delta, 0.01), 0);
  // reservedBps counts only ACTIVE lanes (each needs both bps>0 AND a
  // recipient). A half-configured lane (bps set, recipient missing)
  // does not dock from the contributor pool.
  const reservedBps =
    (ownerActive ? OWNER_BPS : 0) +
    (maintainerActive ? maintainerBps : 0) +
    (treasuryActive ? treasuryBps : 0);
  const contributorPool = 10000 - effectivePlatformBps - reservedBps;

  const contributorSplits: FlexSplit[] = eligible.length > 0
    ? eligible.map((c) => {
        const weight = Math.max(c.cumulative_delta, 0.01) / totalDelta;
        return {
          recipient: c.wallet_address!.trim(),
          bps: Math.max(1, Math.round(weight * contributorPool)),
          role: "contributor" as const,
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

  // Merge order: platform -> owner -> maintainer -> treasury ->
  // contributors (stable for the Flex facilitator's duplicate-recipient
  // remediation). The order also preserves the paper §3.5 partition
  // visually for journal-row readers: $I$, $S$, $M$, $T$, then $C$.
  const splits: FlexSplit[] = [{ recipient: platformRecipient, bps: effectivePlatformBps, role: "infrastructure" }];
  if (ownerSplit) splits.push(ownerSplit);
  if (maintainerSplit) splits.push(maintainerSplit);
  if (treasurySplit) splits.push(treasurySplit);
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
  // Preserve the role tag from the FIRST appearance — duplicate-merge
  // collisions are rare in practice (a contributor wallet == platform
  // recipient is the only realistic case), and the first-seen role is
  // the authoritative one for that recipient's primary purpose.
  const roleByRecipient = new Map<string, FlexSplitRole | undefined>();
  for (const s of splits) {
    const r = s.recipient.trim();
    if (!r) continue;
    if (byRecipient.has(r)) {
      byRecipient.set(r, byRecipient.get(r)! + s.bps);
    } else {
      byRecipient.set(r, s.bps);
      roleByRecipient.set(r, s.role);
      order.push(r);
    }
  }
  return order.map((r) => {
    const role = roleByRecipient.get(r);
    return role !== undefined
      ? { recipient: r, bps: byRecipient.get(r)!, role }
      : { recipient: r, bps: byRecipient.get(r)! };
  });
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
