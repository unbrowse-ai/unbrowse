/**
 * x402 payment primitives — typed shapes the SDK and a wallet agree on.
 *
 * Mirrors the canonical x402 protocol shape (resource-URL flavor) so a generic
 * x402 wallet client can sign these without an Unbrowse-specific adapter. The
 * backend (`backend/src/middleware/x402-gate.ts:X402PaymentRequirementV2`) is
 * the producer; this is the consumer-side declaration.
 *
 * IMPORTANT: this file MUST NOT import from `./client.js` — keep payment
 * helpers tree-shakeable so callers who do not pay can drop the wallet code.
 */

import type { PaymentRequiredError } from "./errors.js";

/**
 * One acceptable payment route returned by a 402 response. The server may
 * present several (different chains, schemes, prices). The wallet picks one.
 */
export interface X402PaymentRequirement {
  /** Settlement scheme, e.g. "exact" for the standard x402 exact-amount path. */
  scheme: string;
  /** Chain identifier, e.g. "base-sepolia", "base", "solana". */
  network: string;
  /** Address that receives the payment. */
  payTo: string;
  /** Atomic-unit amount required (e.g. "1000" for 1000 atomic USDC = $0.001). */
  maxAmountRequired: string;
  /** Resource URL the payment unlocks; agent should not mutate this. */
  resource: string;
  /** Media type expected on success (typically "application/json"). */
  mimeType: string;
  /** Optional human-readable hint. */
  description?: string;
  /** Optional response schema the resource will return after settlement. */
  outputSchema?: unknown;
  /** Scheme-specific extras (token contract address, decimals, EIP-712 domain, etc.). */
  extra?: Record<string, unknown>;
}

/**
 * Payload format the wallet emits and the gateway verifies. Stored
 * base64-encoded in the `X-PAYMENT` request header.
 */
export interface X402PaymentPayload {
  /** Protocol version, currently 1. */
  x402Version: number;
  /** Echoes the scheme of the selected `X402PaymentRequirement`. */
  scheme: string;
  /** Echoes the network of the selected `X402PaymentRequirement`. */
  network: string;
  /** Scheme-specific signed payload (typed-data signature, tx hash, etc.). */
  payload: unknown;
}

/**
 * Minimal contract a caller's wallet must satisfy to settle x402 payments.
 * Implementations live outside the SDK (CDP, viem, solana web3.js, x402-axios).
 */
export interface WalletLike {
  /** Public address used in `accepts[].payTo` matching when relevant. */
  address: string;
  /**
   * Sign the chosen payment requirement and return the base64-encoded
   * `X-PAYMENT` header value the SDK will attach to the retry request.
   */
  signX402Payload(req: X402PaymentRequirement): Promise<string>;
}

/**
 * Day-4 stub. Given a 402 error and a wallet, this will:
 *   1. Pick the cheapest acceptable requirement from `error.accepts`.
 *   2. Call `wallet.signX402Payload` to mint an `X-PAYMENT` header.
 *   3. Invoke `retry(paymentHeader)` and return its result.
 *
 * Day-3 keeps the surface honest: callers compile against this signature
 * today, and Day-4 fills in the body without breaking imports.
 */
export async function payAndRetry<T>(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  error: PaymentRequiredError,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  wallet: WalletLike,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  retry: (paymentHeader: string) => Promise<T>,
): Promise<T> {
  throw new Error("not yet implemented (Day 4)");
}
