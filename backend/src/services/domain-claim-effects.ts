/**
 * Side effects of a successful domain claim or takedown — propagated to
 * existing skills in the marketplace KV namespace.
 *
 * Boundary: `services/domain-claim.ts` owns the KV-key shapes + the DoH
 * verifier (pure primitives). `services/marketplace.ts` owns publish /
 * deprecate / removeDomainFromMarketplace. This file is the GLUE: when
 * verify succeeds OR takedown is requested, walk every skill whose
 * `domain` matches and stamp / disable accordingly. Pure read-through-
 * write-back over `skillsKV`; no LLM, no network, no scoring.
 *
 * Why a separate file: keeping it out of `domain-claim.ts` preserves
 * the primitive's tight scope (just helpers + types + the verifier);
 * keeping it out of `routes/claim.ts` lets the test suite call it
 * directly without an app.fetch round-trip.
 */

import type { Env, SkillManifest } from "../types.js";
import { skillsKV } from "./kv.js";
import { listSkills, invalidateSkillListCaches } from "./marketplace.js";

const SKILL_KV_KEY_PREFIX = "skill:";
function skillKvKey(skill_id: string): string {
  return `${SKILL_KV_KEY_PREFIX}${skill_id}`;
}

export interface OwnerStampResult {
  domain: string;
  stamped_count: number;
  skill_ids: string[];
}

/**
 * After a successful `/v1/claim/verify`, walk every published skill whose
 * `domain` (case-insensitive) matches the verified domain and stamp the
 * owner_* fields so `computeFlexSplits` will route OWNER_BPS to the
 * verified wallet on the next paid execute.
 *
 * Idempotent: re-stamping with the same wallet is a no-op write; re-
 * stamping with a different wallet (after a re-verify) overwrites.
 *
 * Skips skills with `lifecycle === "disabled"` — a disabled skill isn't
 * paying anyone, so writing owner fields would just generate KV churn.
 */
export async function stampOwnerOnDomainSkills(
  env: Env,
  args: {
    domain: string;
    wallet_address: string;
    wallet_usdc_ata?: string;
    verified_at: string;
  },
): Promise<OwnerStampResult> {
  const target = args.domain.trim().toLowerCase();
  const kv = skillsKV(env);
  const all = await listSkills(env);
  const matches = all.filter(
    (s) =>
      (s.domain ?? "").toLowerCase() === target &&
      s.lifecycle !== "disabled",
  );

  const stamped: string[] = [];
  for (const skill of matches) {
    // No-op short-circuit: if every owner field is already at the
    // requested value, skip the write. Cheap idempotency.
    if (
      skill.owner_compensation_opt_in === true &&
      skill.owner_wallet_address === args.wallet_address &&
      (skill.owner_wallet_usdc_ata ?? args.wallet_address) ===
        (args.wallet_usdc_ata ?? args.wallet_address) &&
      skill.owner_wallet_verified_at === args.verified_at
    ) {
      continue;
    }
    const updated: SkillManifest = {
      ...skill,
      owner_compensation_opt_in: true,
      owner_wallet_address: args.wallet_address,
      owner_wallet_usdc_ata: args.wallet_usdc_ata ?? args.wallet_address,
      owner_wallet_verified_at: args.verified_at,
      updated_at: args.verified_at,
    };
    await kv.put(skillKvKey(skill.skill_id), JSON.stringify(updated));
    stamped.push(skill.skill_id);
  }

  if (stamped.length > 0) {
    await invalidateSkillListCaches(env);
  }

  return {
    domain: target,
    stamped_count: stamped.length,
    skill_ids: stamped,
  };
}
