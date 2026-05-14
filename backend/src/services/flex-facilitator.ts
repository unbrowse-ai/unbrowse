/**
 * Flex facilitator instantiation (Day 3 seed, v6.16.0).
 *
 * Day 5 wires `createFacilitatorHandler` from
 * @faremeter/payment-solana/flex/facilitator. Self-host decision is LOCKED per
 * Day-2 firmament. Day 3 only exports the env-binding helpers + stub.
 */

import type { Env } from "../types.js";

export interface FlexFacilitator {
  verify(payload: unknown): Promise<{ ok: boolean; reason?: string }>;
  settle(holdId: string, actualAmountUc: bigint): Promise<{ ok: boolean; txSignature?: string }>;
  flush(): Promise<{ submitted: number; finalized: number }>;
  stop(): Promise<void>;
}

/**
 * Day 3 stub — Day 5 wires @faremeter/payment-solana/flex/facilitator::createFacilitatorHandler.
 * Self-host decision is LOCKED per Day-2 firmament + steering rule.
 */
export async function createFlexFacilitator(_env: Env): Promise<FlexFacilitator> {
  throw new Error("not yet implemented (Day 5) — wires createFacilitatorHandler");
}

export function platformRecipientUsdcAta(env: Env): string {
  const ata = env.FLEX_PLATFORM_RECIPIENT_USDC_ATA?.trim();
  if (!ata) throw new Error("FLEX_PLATFORM_RECIPIENT_USDC_ATA not set");
  return ata;
}

export function flexRefundTimeoutSlots(env: Env): bigint {
  const raw = env.FLEX_REFUND_TIMEOUT_SLOTS?.trim();
  if (!raw) return 150n;  // minimum allowed per Flex spec (~1 min)
  const n = BigInt(raw);
  if (n < 150n) return 150n;
  if (n > 1_296_000n) return 1_296_000n;  // max per Flex spec (~6 days)
  return n;
}
