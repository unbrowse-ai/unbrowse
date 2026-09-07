/**
 * Flex metered pricing helpers (Phase 3, Day 5, v6.16.0).
 *
 * Pure functions over `SkillPricing` — no IO, no env. The route layer
 * calls these to compute the ceiling (verify-time) and the actual
 * billed amount (settle-time) in µ¢ for both fixed-price and metered
 * skills.
 *
 * Backward compat: a skill that lacks `pricing` but carries the legacy
 * top-level `base_price_usd` is treated as `{ mode: "fixed", price_usd }`.
 * Phase 5 (Day 6) will collapse the legacy field; until then this
 * helper is the single source of truth for "what does this skill cost
 * to call?"
 */

import type { SkillManifest, SkillPricing } from "../types.js";

/**
 * Resolve the effective pricing for a skill, folding the legacy
 * `base_price_usd` field into the discriminated union when `pricing`
 * is absent. Returns `{ mode: "fixed", price_usd: 0 }` if neither is
 * set — the route layer should still bill the µ¢ minimum via
 * `computeMaxAmountUc` so escrow holds aren't zero-amount.
 */
export function resolveSkillPricing(skill: SkillManifest): SkillPricing {
  if (skill.pricing) return skill.pricing;
  const legacy = skill.base_price_usd;
  return { mode: "fixed", price_usd: legacy ?? 0 };
}

/**
 * Compute the ceiling amount to authorize at verify-time, in µ¢
 * (micro-cents — 1 USD = 1_000_000 µ¢).
 *
 * For fixed pricing, this is just `price_usd * 1e6` (with a 1 µ¢
 * floor so we never authorize 0).
 *
 * For metered pricing, this is `max_units * cost_per_unit_uc` — the
 * cap the caller has agreed to. Actual settlement may be lower.
 */
export function computeMaxAmountUc(pricing: SkillPricing): bigint {
  if (pricing.mode === "fixed") {
    const uc = Math.round(pricing.price_usd * 1_000_000);
    return BigInt(Math.max(1, uc));
  }
  return BigInt(pricing.max_units) * BigInt(pricing.cost_per_unit_uc);
}

/**
 * Compute the actual amount to settle in µ¢, given the units that were
 * consumed during execution.
 *
 * For fixed pricing, returns the same value as `computeMaxAmountUc`
 * (the caller pays the flat price regardless of `usedUnits`).
 *
 * For metered pricing, returns `ceil(usedUnits) * cost_per_unit_uc`,
 * with `usedUnits` rounded up so any fractional consumption rolls to
 * the next whole unit.
 */
export function computeActualAmountUc(pricing: SkillPricing, usedUnits: number): bigint {
  if (pricing.mode === "fixed") return computeMaxAmountUc(pricing);
  const units = Math.max(0, Math.ceil(usedUnits));
  return BigInt(units) * BigInt(pricing.cost_per_unit_uc);
}
