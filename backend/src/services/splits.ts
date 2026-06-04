/**
 * Contributor payout policy.
 *
 * For now paid skills route to a single contributor wallet only:
 * the current majority contributor by computed share.
 */

import type { AgentProfile, Env, SkillManifest, SkillContributor } from "../types.js";
import { skillsKV, statsKV } from "./kv.js";

// Platform share out of 100 (legacy 100-share split model; Flex uses 1000-of-10000 bps natively in flex.ts::computeFlexSplits)
const PLATFORM_SHARE = 10;
const CONTRIBUTOR_POOL = 100 - PLATFORM_SHARE; // 90 shares for contributors
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Compute contributor shares from their attribution data.
 * Uses cumulative_delta as the weight — agents with uniquely valuable
 * routes (high delta = no good alternative) get larger shares.
 *
 * Falls back to equal split if no delta data exists yet.
 */
export function computeContributorShares(
  contributors: SkillContributor[],
): Array<{ agent_id: string; wallet_address?: string; share: number }> {
  if (contributors.length === 0) return [];

  // Filter to contributors with wallet addresses (can't pay without one)
  const payable = contributors.filter((c) => c.wallet_address);
  if (payable.length === 0) return [];

  const totalDelta = payable.reduce((s, c) => s + Math.max(c.cumulative_delta, 0.01), 0);

  const shares = payable.map((c) => {
    const weight = Math.max(c.cumulative_delta, 0.01) / totalDelta;
    return {
      agent_id: c.agent_id,
      wallet_address: c.wallet_address,
      share: Math.max(1, Math.round(weight * CONTRIBUTOR_POOL)),
    };
  });

  // Normalize so contributor shares + platform = 100
  const totalShares = shares.reduce((s, c) => s + c.share, 0);
  if (totalShares !== CONTRIBUTOR_POOL) {
    // Adjust largest contributor to make it sum correctly
    shares.sort((a, b) => b.share - a.share);
    shares[0].share += CONTRIBUTOR_POOL - totalShares;
  }

  return shares;
}

export function getAgentWallet(profile?: Pick<AgentProfile, "wallet_address" | "wallet_provider"> | null): {
  wallet_address?: string;
  wallet_provider?: string;
} {
  const walletAddress = profile?.wallet_address?.trim();
  if (!walletAddress) return {};
  return {
    wallet_address: walletAddress,
    wallet_provider: profile?.wallet_provider?.trim() || undefined,
  };
}

export function selectPrimaryContributor(
  contributors: SkillContributor[],
): { agent_id: string; wallet_address?: string; share: number } | null {
  const shares = computeContributorShares(contributors);
  if (shares.length === 0) return null;

  let primary = shares[0]!;
  for (const share of shares.slice(1)) {
    if (share.share > primary.share) primary = share;
  }
  return primary;
}

export function syncSkillSplitConfig(skill: SkillManifest): SkillManifest {
  const primary = selectPrimaryContributor(skill.contributors ?? []);
  if (!primary?.wallet_address?.trim()) {
    const { split_config: _splitConfig, ...rest } = skill;
    return rest;
  }
  return { ...skill, split_config: primary.wallet_address.trim() };
}

export function resolveSkillPaymentRecipient(skill: SkillManifest, env: Pick<Env, "PAYMENT_RECIPIENT">): string {
  const primary = selectPrimaryContributor(skill.contributors ?? []);
  if (primary?.wallet_address?.trim()) return primary.wallet_address.trim();

  const splitConfig = skill.split_config?.trim();
  if (splitConfig) return splitConfig;

  return env.PAYMENT_RECIPIENT ?? ZERO_ADDRESS;
}

/**
 * Build the split-recipients array for a skill (legacy Cascade-shape;
 * Flex equivalent lives in flex.ts::computeFlexSplits and produces bps).
 * Returns recipients ready for ensureSplit().
 */
export function buildSplitRecipients(
  contributors: SkillContributor[],
  platformWallet: string,
): Array<{ address: string; share: number }> {
  const shares = computeContributorShares(contributors);
  if (shares.length === 0) {
    // No payable contributors — all to platform
    return [{ address: platformWallet, share: 100 }];
  }

  const recipients: Array<{ address: string; share: number }> = [
    { address: platformWallet, share: PLATFORM_SHARE },
  ];

  for (const s of shares) {
    if (s.wallet_address) {
      recipients.push({ address: s.wallet_address, share: s.share });
    }
  }

  return recipients;
}

export type ContributorPayout = {
  agent_id: string;
  wallet_address?: string;
  share: number;
  payout_uc: number;
};

export function computeContributorPayouts(
  contributors: SkillContributor[],
  totalPayoutUc: number,
  fallbackCreatorId?: string,
): ContributorPayout[] {
  const primary = selectPrimaryContributor(contributors);
  if (!primary) {
    if (!fallbackCreatorId) return [];
    return [{
      agent_id: fallbackCreatorId,
      share: CONTRIBUTOR_POOL,
      payout_uc: totalPayoutUc,
    }];
  }
  return [{
    agent_id: primary.agent_id,
    wallet_address: primary.wallet_address,
    share: CONTRIBUTOR_POOL,
    payout_uc: totalPayoutUc,
  }];
}

/**
 * Merge a new contributor into an existing contributors list.
 * If the agent already contributed, update their stats.
 * If new, add them with initial values.
 */
export function mergeContributor(
  existing: SkillContributor[],
  agentId: string,
  endpointsAdded: number,
  walletAddress?: string,
): SkillContributor[] {
  const now = new Date().toISOString();
  const contributors = [...existing];
  const idx = contributors.findIndex((c) => c.agent_id === agentId);

  if (idx >= 0) {
    contributors[idx] = {
      ...contributors[idx],
      endpoints_contributed: contributors[idx].endpoints_contributed + endpointsAdded,
      last_contributed_at: now,
      ...(walletAddress ? { wallet_address: walletAddress } : {}),
    };
  } else {
    contributors.push({
      agent_id: agentId,
      wallet_address: walletAddress,
      endpoints_contributed: endpointsAdded,
      cumulative_delta: 0,
      share: 0,
      first_contributed_at: now,
      last_contributed_at: now,
    });
  }

  // Recompute shares
  const shares = computeContributorShares(contributors);
  const shareMap = new Map(shares.map((s) => [s.agent_id, s.share]));
  for (const c of contributors) {
    c.share = shareMap.get(c.agent_id) ?? 0;
  }

  return contributors;
}

/**
 * Store the split config address for a skill in KV.
 */
export async function storeSplitConfig(
  env: Env,
  skillId: string,
  splitConfigAddress: string,
): Promise<void> {
  const kv = statsKV(env);
  await kv.put(`split:${skillId}`, splitConfigAddress);
}

/**
 * Get the split config address for a skill from KV.
 */
export async function getSplitConfig(
  env: Env,
  skillId: string,
): Promise<string | null> {
  const kv = statsKV(env);
  return await kv.get(`split:${skillId}`) as string | null;
}

/**
 * Update contributor delta scores from attribution events.
 * Called after recordAttribution to keep contributor shares in sync.
 */
/**
 * Decay rate applied to all contributors' cumulative_delta on each execution.
 * 0.95 = 5% decay per execution — contributors must keep providing value
 * or their share erodes. A contributor whose routes are never chosen
 * decays to near-zero in ~60 executions.
 */
const DELTA_DECAY_RATE = 0.95;

/** Minimum delta threshold — contributors below this lose their share entirely. */
const MIN_DELTA_THRESHOLD = 0.01;

/**
 * Update contributor delta scores from attribution events.
 * Applies exponential decay to ALL contributors, then adds the new delta
 * to the credited contributor. This means:
 * - Active contributors (routes frequently chosen) maintain/grow share
 * - Inactive contributors (routes replaced by better ones) decay to 0
 * - Contributors below MIN_DELTA_THRESHOLD are pruned
 */
export async function updateContributorDelta(
  env: Env,
  skillId: string,
  indexerId: string,
  deltaScore: number,
): Promise<void> {
  const kv = skillsKV(env);
  const skillRaw = await kv.get(`skill:${skillId}`) as string | null;
  if (!skillRaw) return;

  try {
    const skill = JSON.parse(skillRaw) as SkillManifest;
    let contributors = skill.contributors ?? [];

    // Decay all contributors' cumulative_delta
    for (const c of contributors) {
      c.cumulative_delta *= DELTA_DECAY_RATE;
    }

    // Credit (or, with a negative deltaScore from a slash, debit) the active
    // contributor. Floored at 0 — standing never goes negative.
    const idx = contributors.findIndex((c) => c.agent_id === indexerId);
    if (idx >= 0) {
      contributors[idx].cumulative_delta = Math.max(0, contributors[idx].cumulative_delta + deltaScore);
    }

    // Prune contributors below threshold — they've lost impact
    contributors = contributors.filter((c) => c.cumulative_delta >= MIN_DELTA_THRESHOLD);

    // Recompute shares
    const shares = computeContributorShares(contributors);
    const shareMap = new Map(shares.map((s) => [s.agent_id, s.share]));
    for (const c of contributors) {
      c.share = shareMap.get(c.agent_id) ?? 0;
    }

    skill.contributors = contributors;
    await kv.put(`skill:${skillId}`, JSON.stringify(syncSkillSplitConfig(skill)));
  } catch { /* non-fatal */ }
}
