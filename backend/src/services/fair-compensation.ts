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
 * Default 20% (2000 bps). Override per-deployment with env `FAIR_COMPENSATION_BPS` (0–10000).
 * Compensation is paid to the platform wallet (`PAYMENT_RECIPIENT`).
 */

/** Unbrowse's default fair-compensation rate on facilitated transaction costs: 20%. */
export const FAIR_COMPENSATION_BPS = 2000;

const BPS_DENOMINATOR = 10_000;

/** Resolve the effective compensation rate (bps), honoring the env override and clamping to
 *  a sane [0, 10000] range. Garbage / out-of-range values fall back to the 20% default rather
 *  than throwing, so a misconfigured deployment still settles cleanly. */
export function fairCompensationBps(env?: { FAIR_COMPENSATION_BPS?: string | number }): number {
  const raw = env?.FAIR_COMPENSATION_BPS;
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > BPS_DENOMINATOR) return FAIR_COMPENSATION_BPS;
  return Math.round(n);
}

export interface CompensatedCost {
  /** The raw upstream cost the platform pays (USD). */
  upstreamUsd: number;
  /** The fair-compensation share added on top (USD). */
  compensationUsd: number;
  /** What the agent is charged: upstream + compensation (USD). */
  totalUsd: number;
  /** The rate applied (bps). */
  bps: number;
}

/** USD markup: given the raw upstream tx cost, return what the agent pays + the platform's cut. */
export function compensateTxCost(
  upstreamCostUsd: number,
  env?: { FAIR_COMPENSATION_BPS?: string | number },
): CompensatedCost {
  const bps = fairCompensationBps(env);
  const upstreamUsd = Number.isFinite(upstreamCostUsd) && upstreamCostUsd > 0 ? upstreamCostUsd : 0;
  const compensationUsd = (upstreamUsd * bps) / BPS_DENOMINATOR;
  return { upstreamUsd, compensationUsd, totalUsd: upstreamUsd + compensationUsd, bps };
}

export interface CompensatedCostUc {
  /** Raw upstream cost in µUSDC (1e-6 USDC). */
  upstreamUc: bigint;
  /** Fair-compensation share in µUSDC (rounded UP — platform never under-compensated). */
  compensationUc: bigint;
  /** Total charged to the agent in µUSDC. */
  totalUc: bigint;
  bps: number;
}

/** On-chain (µUSDC, integer) markup. Compensation rounds UP (ceil) so sub-µ rounding never
 *  shorts the platform; a zero or negative upstream yields zero compensation. */
export function compensateTxCostUc(
  upstreamCostUc: bigint,
  env?: { FAIR_COMPENSATION_BPS?: string | number },
): CompensatedCostUc {
  const bps = BigInt(fairCompensationBps(env));
  const upstreamUc = upstreamCostUc > 0n ? upstreamCostUc : 0n;
  const compensationUc = (upstreamUc * bps + (BigInt(BPS_DENOMINATOR) - 1n)) / BigInt(BPS_DENOMINATOR);
  return { upstreamUc, compensationUc, totalUc: upstreamUc + compensationUc, bps: Number(bps) };
}

/** The platform wallet that receives the compensation (USDC ATA / address), or undefined when
 *  unset — callers MUST treat undefined as "cannot broker for compensation" rather than dropping
 *  the cut silently. */
export function fairCompensationRecipient(env?: { PAYMENT_RECIPIENT?: string }): string | undefined {
  const r = env?.PAYMENT_RECIPIENT?.trim();
  return r ? r : undefined;
}
