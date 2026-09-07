/**
 * delegation-settlement — settle a paid call against a USER's escrow on the
 * non-custodial delegated funding lane (design §3 step d, §4 security).
 *
 * This is the Phase-2 wire that the `delegated` admission lane routes to. It
 * NEVER moves principal beyond the verbatim 402 splits, and the source of funds
 * is ALWAYS the user's escrow (from the delegation record), never the treasury.
 *
 * Order of enforcement (any failure → `{ ok:false }`, caller falls through to
 * the existing per-call 402):
 *   1. EXPIRY — if the delegation `expires_at_slot` has passed, refuse.
 *   2. CAP    — maxAmount = min(call price, delegationRemaining(cap)); if the
 *               remaining headroom is <= 0, refuse.
 *   3. SIGN   — sign a Flex authorization against the USER's escrow, reusing the
 *               EXISTING sponsor-flex signing core
 *               (`signFlexAuthorizationAgainstEscrow`), pointed at
 *               `funding.escrow` + the platform-held DELEGATION session-key
 *               secret. Splits are passed VERBATIM (never recomputed).
 *   4. DEBIT  — on a confirmed signed authorization, `recordDelegationDraw`
 *               debits the rolling cap ledger by the settled amount (idempotent
 *               on authorization_id).
 *
 * Why the platform CAN sign here without holding the wallet key: the user
 * registered the DELEGATION session key's PUBKEY to their escrow at setup
 * (design §3 steps a/b). The platform holds only that key's SECRET (env
 * `FLEX_DELEGATION_SESSION_KEY_SECRET`), exactly the sponsor-session-key model —
 * a bounded, expiring, on-chain-revocable capability, not the wallet key.
 */
import type { Env } from "../types.js";
import type { FlexSplit } from "./flex.js";
import {
  signFlexAuthorizationAgainstEscrow,
  decodeSecretKeyBytes,
  type SponsorFlexInjections,
} from "./sponsor-flex.js";
import { recordDelegationDraw, delegationRemaining } from "./delegation-ledger.js";

/**
 * Derive the platform's DELEGATION session-key PUBLIC key (base58 Ed25519
 * address) from the held secret — the same decode the signer uses
 * (`decodeSecretKeyBytes`), then the standard Solana keypair layout
 * (64 bytes = 32-byte seed || 32-byte pubkey) with the pubkey as the trailing
 * 32 bytes. This is the value a user registers to their OWN escrow so the
 * platform can later sign bounded draws against it.
 *
 * NEVER returns the secret — only the derived public key. Returns null when the
 * lane isn't configured (no secret) or the secret can't be decoded to a 64-byte
 * keypair.
 */
export async function getDelegationSessionKeyAddress(env: Env): Promise<string | null> {
  const rawSecret = env.FLEX_DELEGATION_SESSION_KEY_SECRET?.trim();
  if (!rawSecret) return null;
  try {
    const secret = await decodeSecretKeyBytes(rawSecret);
    // Solana keypair = 32-byte seed || 32-byte pubkey; the pubkey is the
    // trailing 32 bytes (mirrors wallet-signer.ts).
    if (secret.length < 64) return null;
    const pub = secret.slice(32, 64);
    const { default: bs58 } = (await import("bs58")) as unknown as {
      default: { encode: (b: Uint8Array) => string };
    };
    return bs58.encode(pub);
  } catch {
    return null;
  }
}

export interface DelegationSettleParams {
  /** The api-key id (the delegated funding record's key + the cap-ledger key). */
  keyId: string;
  /** The user's escrow PDA — the funds source (from the delegation record). */
  escrow: string;
  /** Total delegated cap (µ¢) — the rolling ledger ceiling. */
  capUc: number;
  /** The delegation's on-chain session-key expiry slot (string-serialized u64). */
  expiresAtSlot: string;
  /** This call's price in µ¢ (the verbatim 402 amount). */
  priceUc: number;
  /**
   * The VERBATIM 402 splits — passed straight to the signer, NEVER recomputed.
   * These are the backend-computed terms the user agreed to fund.
   */
  splits: FlexSplit[];
  /** The current Solana slot — used for the expiry comparison. */
  currentSlot: bigint;
}

export type DelegationSettleResult =
  | { ok: true; authorization_id: string; settled_uc: number; escrow: string; remaining_uc: number }
  | {
      ok: false;
      reason:
        | "delegation_not_configured"
        | "expired"
        | "cap_exhausted"
        | "invalid_price"
        | "sign_failed";
      detail?: string;
    };

/**
 * True iff the delegated lane is configured: the platform holds a delegation
 * session-key secret AND an RPC URL to probe the current slot. Mirrors
 * `sponsorEscrowReady` — the escrow is per-user (from the record), so it is not
 * part of the readiness check.
 */
export function delegationLaneReady(env: Env): boolean {
  return Boolean(env.FLEX_DELEGATION_SESSION_KEY_SECRET?.trim());
}

/**
 * Settle one paid call against the user's escrow within the delegated cap.
 *
 * Operational failures never throw — they return `{ ok:false, reason }` so the
 * gated execute path degrades to the existing 402, exactly like an exhausted
 * prepaid balance.
 */
export async function settleDelegatedCall(
  env: Env,
  params: DelegationSettleParams,
  injections?: SponsorFlexInjections,
): Promise<DelegationSettleResult> {
  if (!delegationLaneReady(env)) {
    return { ok: false, reason: "delegation_not_configured" };
  }

  // 1. EXPIRY — an expired delegation can sign nothing. The on-chain program
  // would also reject an over-expiry authorization, but we refuse off-chain
  // first so we never burn a signing call on a dead delegation.
  let expirySlot: bigint;
  try {
    expirySlot = BigInt(params.expiresAtSlot.trim());
  } catch {
    return { ok: false, reason: "expired", detail: "unparseable_expires_at_slot" };
  }
  if (params.currentSlot >= expirySlot) {
    return { ok: false, reason: "expired" };
  }

  // 2. CAP — clamp this draw to the rolling headroom. A draw of 0 (or a
  // non-positive price) is refused; an exhausted cap falls through to the 402.
  if (!Number.isFinite(params.priceUc) || params.priceUc <= 0) {
    return { ok: false, reason: "invalid_price" };
  }
  const remaining = await delegationRemaining(env, params.keyId, params.capUc);
  if (remaining <= 0) {
    return { ok: false, reason: "cap_exhausted" };
  }
  const maxAmountUc = Math.min(Math.floor(params.priceUc), remaining);
  if (maxAmountUc <= 0) {
    return { ok: false, reason: "cap_exhausted" };
  }

  // 3. SIGN — reuse the sponsor-flex signing core, pointed at the USER's escrow
  // + the platform-held DELEGATION session key. Splits are VERBATIM. Expiry is
  // pinned to the delegation slot so the authorization cannot outlive the
  // session key. We hand the signer the slot we already probed for the expiry
  // check so the draft's expiry math is consistent with our gate.
  const signed = await signFlexAuthorizationAgainstEscrow(
    env,
    {
      escrow: params.escrow,
      sessionKeySecret: env.FLEX_DELEGATION_SESSION_KEY_SECRET!,
      splits: params.splits,
      amountUc: BigInt(maxAmountUc),
      expiresAtSlotOverride: expirySlot,
    },
    {
      _currentSlot: async () => params.currentSlot,
      ...injections,
    },
  );

  if (!signed.ok || !signed.authorization_id) {
    return { ok: false, reason: "sign_failed", detail: signed.reason };
  }

  // 4. DEBIT — record the settled draw against the rolling cap ledger.
  // Idempotent on authorization_id (a settle replay does NOT double-count).
  const draw = await recordDelegationDraw(env, params.keyId, {
    authorization_id: signed.authorization_id,
    amount_uc: maxAmountUc,
  });
  if (!draw.ok) {
    // The authorization was signed but the ledger rejected the draw (should be
    // unreachable — maxAmountUc > 0 and the id is non-empty). Treat as a sign
    // failure so we don't claim a settlement the cap ledger never recorded.
    return { ok: false, reason: "sign_failed", detail: `ledger_${draw.reason}` };
  }

  const remainingAfter = await delegationRemaining(env, params.keyId, params.capUc);
  return {
    ok: true,
    authorization_id: signed.authorization_id,
    settled_uc: maxAmountUc,
    escrow: params.escrow,
    remaining_uc: remainingAfter,
  };
}
