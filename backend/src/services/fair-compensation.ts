/**
 * Fair-compensation engine — unbrowse's native take-rate on FACILITATED TRANSACTION COSTS.
 *
 * When the platform fronts a paid upstream on an agent's behalf — an x402 web-unblocker
 * (200ok, OnchainExpat), an LLM proxy (xgate.run), a paid third-party API, a facilitator or
 * gas fee — it recoups a fair share on TOP of the raw cost. This module is the single source
 * of truth for that rate; every brokered-pricing path (the unlock reseller, the LLM-proxy
 * markup, any "unbrowse pays upstream, charges the agent" surface) derives its charge from
 * `compensateTxCost` / `compensateTxCostUc` rather than hand-rolling a markup.
 *
 * Distinct from the Flex platform SPLIT (`PLATFORM_BPS` in services/flex.ts — a cut taken from a
 * skill's OWN price during settlement). This engine is the markup on COSTS the platform itself
 * incurs while brokering. The two compose: a brokered skill can carry both a Flex split on its
 * price and a fair-compensation markup on the upstream cost it triggers.
 *
 * Default 0% — execution is FREE: unbrowse takes no cut on the commons. A fronted paid
 * upstream is passed through at raw cost (caller covers genuine cost; unbrowse adds nothing).
 * Monetization is OPT-IN at the edge: a website/skill owner prices their endpoint (Flex/x402)
 * and the router tolls THAT via the Flex `PLATFORM_BPS` split / per-skill `markup_bps`.
 * "Render unto Caesar what is Caesar's" — toll the opt-in paid edge, leave the free commons free.
 * Override per-deployment with env `FAIR_COMPENSATION_BPS` (0–10000) to re-enable a broker markup.
 * Compensation, when non-zero, is paid to the platform wallet (`PAYMENT_RECIPIENT`).
 */

/** Default fair-compensation rate on facilitated transaction costs: 0% (execution is free;
 *  monetization is opt-in via the owner-priced Flex/x402 edge, not a markup on the commons). */
export const FAIR_COMPENSATION_BPS = 0;

const BPS_DENOMINATOR = 10_000;

/** Resolve the effective compensation rate (bps), honoring the env override and clamping to
 *  a sane [0, 10000] range. Garbage / out-of-range values fall back to the 0% default rather
 *  than throwing, so a misconfigured deployment still settles cleanly. */
export function fairCompensationBps(env?: { FAIR_COMPENSATION_BPS?: string | number }): number {
  const raw = env?.FAIR_COMPENSATION_BPS;
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > BPS_DENOMINATOR) return FAIR_COMPENSATION_BPS;
  return Math.round(n);
}

export interface CompensatedUsd {
  /** Raw upstream cost in USD (clamped ≥ 0). */
  upstreamUsd: number;
  /** Platform markup in USD (0 when default free posture). */
  compensationUsd: number;
  /** Agent-facing total = upstream + compensation. */
  totalUsd: number;
  /** Effective bps used for this computation. */
  bps: number;
}

export interface CompensatedUc {
  /** Raw upstream cost in µUSDC (bigint, clamped ≥ 0). */
  upstreamUc: bigint;
  /** Platform markup in µUSDC (ceil so platform is never shorted by sub-µ). */
  compensationUc: bigint;
  /** Agent-facing total = upstream + compensation. */
  totalUc: bigint;
  /** Effective bps used for this computation. */
  bps: number;
}

/**
 * USD-side compensation. Negative / NaN upstream clamps to 0.
 * Default 0 bps → pass-through at cost.
 */
export function compensateTxCost(
  rawUsd: number,
  env?: { FAIR_COMPENSATION_BPS?: string | number },
): CompensatedUsd {
  const bps = fairCompensationBps(env);
  const upstreamUsd = Number.isFinite(rawUsd) && rawUsd > 0 ? rawUsd : 0;
  const compensationUsd = (upstreamUsd * bps) / BPS_DENOMINATOR;
  return {
    upstreamUsd,
    compensationUsd,
    totalUsd: upstreamUsd + compensationUsd,
    bps,
  };
}

/**
 * µUSDC (on-chain integer) compensation. Ceils markup so the platform is never
 * shorted by a sub-µ fraction. Negative upstream → 0 compensation.
 */
export function compensateTxCostUc(
  rawUc: bigint,
  env?: { FAIR_COMPENSATION_BPS?: string | number },
): CompensatedUc {
  const bps = fairCompensationBps(env);
  const upstreamUc = rawUc > 0n ? rawUc : 0n;
  // ceil(upstream * bps / 10000) via integer arithmetic: (n * bps + 9999) / 10000
  const compensationUc =
    upstreamUc === 0n || bps === 0
      ? 0n
      : (upstreamUc * BigInt(bps) + BigInt(BPS_DENOMINATOR - 1)) / BigInt(BPS_DENOMINATOR);
  return {
    upstreamUc,
    compensationUc,
    totalUc: upstreamUc + compensationUc,
    bps,
  };
}

/** Platform wallet that receives fair-compensation (PAYMENT_RECIPIENT). */
export function fairCompensationRecipient(env?: {
  PAYMENT_RECIPIENT?: string;
}): string | undefined {
  const v = env?.PAYMENT_RECIPIENT?.trim();
  return v ? v : undefined;
}
