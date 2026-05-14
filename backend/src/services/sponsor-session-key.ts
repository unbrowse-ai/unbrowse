/**
 * Sponsor session-key rotation audit (v6.16 Phase 4, requirement R6).
 *
 * Faremeter Flex sponsor signing uses an Ed25519 session key separate from the
 * platform sponsor wallet. The session key signs payment authorizations on
 * behalf of the wallet for a bounded slot window. Per Flex docs and Phase 4.4
 * of `docs/x402-routing-plan-v6.16.md`, the recommended minimum window is
 * ~48 hours (≈ 432_000 slots at 400ms/slot); the hard cap is ~96h to limit
 * blast-radius of a leaked session key.
 *
 * Session keys are bare Ed25519 keypairs and carry NO intrinsic expiry
 * metadata. We track the expiry slot out-of-band via
 * `FLEX_SPONSOR_SESSION_KEY_EXPIRES_AT_SLOT` (env var; rotated alongside the
 * secret). This module is read-only — it never decodes/uses the key for
 * signing, only reports configuration + remaining-slot health so an operator
 * (or admin endpoint consumer) knows when to rotate.
 *
 * `shouldRotateSponsorSessionKey` flips to true once half the recommended
 * window has elapsed (slots_remaining < MIN/2). That gives the operator a
 * 24h window to rotate before the key expires.
 */

import type { Env } from "../types.js";

export interface SponsorSessionKeyStatus {
  configured: boolean;
  /** bigint as string — JSON-safe; slots are uint64. */
  expires_at_slot?: string;
  current_slot?: string;
  slots_until_expiry?: string;
  recommended_rotate_at_slots?: string;
}

// 1 Solana slot ≈ 400ms. 48h ≈ 432_000 slots (the Flex-recommended minimum).
// 96h ≈ 864_000 slots is the documented hard cap for session-key lifetime.
export const SPONSOR_SESSION_KEY_MIN_EXPIRY_SLOTS = 432_000n;
export const SPONSOR_SESSION_KEY_MAX_EXPIRY_SLOTS = 864_000n;

/**
 * Read-only health check for the configured sponsor session key.
 *
 * Returns `{configured: false}` when the secret is unset (sponsor signing
 * disabled). Returns `{configured: true}` with the expiry/slot fields filled
 * in when both the secret AND its tracked expiry slot are set. If the secret
 * is set but the expiry slot is missing, returns `{configured: true}` with
 * no slot fields — operators should populate `FLEX_SPONSOR_SESSION_KEY_EXPIRES_AT_SLOT`
 * at the same time they rotate the key.
 *
 * Never throws — RPC failures degrade to `{configured: true}` so the admin
 * surface stays readable.
 */
export async function getSponsorSessionKeyStatus(env: Env): Promise<SponsorSessionKeyStatus> {
  if (!env.FLEX_SPONSOR_SESSION_KEY_SECRET?.trim()) {
    return { configured: false };
  }

  const expiresAtRaw = env.FLEX_SPONSOR_SESSION_KEY_EXPIRES_AT_SLOT?.trim();
  if (!expiresAtRaw) {
    return { configured: true };
  }

  let expiresAtSlot: bigint;
  try {
    expiresAtSlot = BigInt(expiresAtRaw);
  } catch {
    return { configured: true };
  }

  const rpcUrl = env.CASCADE_RPC_URL?.trim();
  if (!rpcUrl) {
    return {
      configured: true,
      expires_at_slot: expiresAtSlot.toString(),
      recommended_rotate_at_slots: (SPONSOR_SESSION_KEY_MIN_EXPIRY_SLOTS / 2n).toString(),
    };
  }

  try {
    const kit = await import("@solana/kit");
    const rpc = kit.createSolanaRpc(rpcUrl);
    const currentSlotRaw = await rpc.getSlot().send();
    const currentSlot = BigInt(currentSlotRaw as unknown as bigint | number | string);
    const slotsRemaining = expiresAtSlot > currentSlot ? expiresAtSlot - currentSlot : 0n;

    return {
      configured: true,
      expires_at_slot: expiresAtSlot.toString(),
      current_slot: currentSlot.toString(),
      slots_until_expiry: slotsRemaining.toString(),
      recommended_rotate_at_slots: (SPONSOR_SESSION_KEY_MIN_EXPIRY_SLOTS / 2n).toString(),
    };
  } catch {
    // RPC unavailable — return configured/expiry without live slot.
    return {
      configured: true,
      expires_at_slot: expiresAtSlot.toString(),
      recommended_rotate_at_slots: (SPONSOR_SESSION_KEY_MIN_EXPIRY_SLOTS / 2n).toString(),
    };
  }
}

/**
 * True iff the session key should be rotated NOW. Returns false when the
 * key isn't configured (nothing to rotate) or when live-slot info is
 * unavailable (admin surface stays readable; rotation decision deferred).
 */
export function shouldRotateSponsorSessionKey(status: SponsorSessionKeyStatus): boolean {
  if (!status.configured) return false;
  if (!status.slots_until_expiry) return false;
  let remaining: bigint;
  try {
    remaining = BigInt(status.slots_until_expiry);
  } catch {
    return false;
  }
  return remaining < SPONSOR_SESSION_KEY_MIN_EXPIRY_SLOTS / 2n;
}
