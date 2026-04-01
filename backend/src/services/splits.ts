/**
 * Cascade Splits integration — on-chain revenue sharing for skill contributors.
 *
 * When a skill has multiple contributors (agents who captured endpoints),
 * this service creates/updates a Cascade Split so x402 payments are
 * automatically distributed proportional to each contributor's delta score.
 *
 * Split address is deterministic per skill: labelToSeed("unbrowse:{skill_id}")
 * Platform gets PLATFORM_SHARE (10%), rest split among contributors.
 */

import type { Env, SkillManifest, SkillContributor } from "../types.js";
import { statsKV } from "./kv.js";

// Platform share out of 100 (Cascade uses 100-share model, protocol takes 1%)
const PLATFORM_SHARE = 10;
const CONTRIBUTOR_POOL = 100 - PLATFORM_SHARE; // 90 shares for contributors

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

/**
 * Build the Cascade Split recipients array for a skill.
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
export async function updateContributorDelta(
  env: Env,
  skillId: string,
  indexerId: string,
  deltaScore: number,
): Promise<void> {
  const kv = statsKV(env);
  const skillRaw = await kv.get(`skill:${skillId}`) as string | null;
  if (!skillRaw) return;

  try {
    const skill = JSON.parse(skillRaw) as SkillManifest;
    const contributors = skill.contributors ?? [];
    const idx = contributors.findIndex((c) => c.agent_id === indexerId);
    if (idx >= 0) {
      contributors[idx].cumulative_delta += deltaScore;
    }

    // Recompute shares
    const shares = computeContributorShares(contributors);
    const shareMap = new Map(shares.map((s) => [s.agent_id, s.share]));
    for (const c of contributors) {
      c.share = shareMap.get(c.agent_id) ?? 0;
    }

    skill.contributors = contributors;
    await kv.put(`skill:${skillId}`, JSON.stringify(skill));
  } catch { /* non-fatal */ }
}
