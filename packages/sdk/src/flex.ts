/**
 * Flex payment primitives — typed shapes for the @faremeter/flex-solana
 * escrow-and-session-key payment scheme. Day-3 mustard seed: type contract
 * only. Day-4 wires up real @faremeter/flex-solana calls.
 *
 * Aligned with @faremeter/flex-solana wire types as inspected in
 * /tmp/flex-probe/node_modules/@faremeter/flex-solana/dist/src/types.d.ts —
 * specifically `FlexPaymentPayload` (escrow, mint, maxAmount, authorizationId,
 * expiresAtSlot, splits[], sessionKey, signature) and the
 * `SerializePaymentAuthorizationArgs` type from authorization.d.ts.
 *
 * IMPORTANT: this file MUST NOT import @faremeter/flex-solana at top-level —
 * the Flex codepath stays tree-shakeable so callers who never pay Flex don't
 * pull in @solana/kit. Day-4 will use dynamic `await import()` inside the
 * function bodies, same pattern as `x402.ts`.
 */

import type { PaymentRequiredError } from "./errors.js";

/**
 * Unsigned Flex payment authorization. Matches the persistable subset of
 * `FlexPaymentPayload` from @faremeter/flex-solana minus the wire-only
 * `sessionKey` (added at signing time) and `signature` (added at signing
 * time). All numeric fields are base10 strings so the shape survives JSON.
 */
export interface FlexAuthorization {
  /** Base58 escrow PDA. */
  escrow: string;
  /** USDC mint address (base58). */
  mint: string;
  /** µ¢ atomic units the facilitator may draw, as base10 string. */
  maxAmount: string;
  /** Random u64 as base10 string, used for replay protection. */
  authorizationId: string;
  /** Slot height after which this authorization is invalid, as base10 string. */
  expiresAtSlot: string;
  /**
   * Up to 5 splits whose bps sum to exactly 10000. Each recipient is a
   * base58 token-account address; bps is an integer in [1, 10000].
   * Matches `SplitInput` from @faremeter/flex-solana/authorization.d.ts.
   */
  splits: Array<{ recipient: string; bps: number }>;
}

/**
 * Minimal contract a caller's Flex wallet must satisfy. The wallet owns
 * the escrow PDA AND has registered a session key — both wire-time facts
 * the SDK does not produce, only consume.
 */
export interface FlexWalletLike {
  /** Wallet address that owns the escrow PDA (base58). */
  address: string;
  /** Registered session key address (base58). */
  sessionKeyAddress: string;
  /**
   * Sign the authorization with the session key's Ed25519 secret. Returns
   * the 64-byte signature as base64 — same shape the on-chain
   * `createEd25519VerifyInstruction` expects.
   */
  signFlexAuthorization(auth: FlexAuthorization): Promise<string>;
}

/** Arguments for `fundEscrow` — Day-4 will turn this into a real RPC call. */
export interface FlexFundEscrowParams {
  walletAddress: string;
  facilitatorAddress: string;
  amountUsdc: string;
  refundTimeoutSlots?: number;
  deadmanTimeoutSlots?: number;
}

/** Arguments for `registerSessionKey` — Day-4 will turn this into a real RPC call. */
export interface FlexRegisterSessionKeyParams {
  walletAddress: string;
  escrowAddress: string;
  sessionKeyAddress: string;
  expiresAtSlot?: string;
}

/**
 * Build an unsigned `FlexAuthorization`. Day-3 stub: rejects honestly.
 * Day-4 will validate the splits sum to 10000, generate a random
 * `authorizationId`, and return the canonical shape.
 */
export async function buildFlexAuthorization(
  _opts: {
    escrow: string;
    mint: string;
    maxAmount: string;
    splits: FlexAuthorization["splits"];
    expiresAtSlot: string;
  },
): Promise<FlexAuthorization> {
  throw new Error("not yet implemented (Day 4)");
}

/**
 * Settle a `PaymentRequiredError` whose `accepts[]` advertises a Flex
 * scheme. Day-3 stub: rejects honestly. Day-4 will pick the Flex
 * requirement, call `wallet.signFlexAuthorization`, encode the
 * `FlexPaymentPayload`, and replay via `retry(paymentHeader)`.
 */
export async function payAndRetryFlex<T>(
  _error: PaymentRequiredError,
  _wallet: FlexWalletLike,
  _retry: (paymentHeader: string) => Promise<T>,
): Promise<T> {
  throw new Error("not yet implemented (Day 4)");
}

/**
 * Send a `getCreateEscrowInstructionAsync` + `getDepositInstructionAsync`
 * transaction on the caller's behalf. Day-3 stub: rejects honestly.
 */
export async function fundEscrow(
  _params: FlexFundEscrowParams,
): Promise<{ escrowAddress: string; txSignature: string }> {
  throw new Error("not yet implemented (Day 4)");
}

/**
 * Send a `getRegisterSessionKeyInstructionAsync` transaction. Day-3 stub:
 * rejects honestly.
 */
export async function registerSessionKey(
  _params: FlexRegisterSessionKeyParams,
): Promise<{ txSignature: string }> {
  throw new Error("not yet implemented (Day 4)");
}
