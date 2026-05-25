// src/payments/flex-pay.ts
// Faremeter Flex client settlement seam (evidence-build unbrowse-flex-settlement).
// ONE shared entry both the CLI 402 path (src/client/index.ts) and the MCP
// 402 path (src/mcp.ts) funnel through, before their lobster/buildGateRefusal
// fallbacks. Contract (firmament): success -> { data, settled:true,
// authorization }; not-applicable (not Flex / no provisioned escrow) -> null
// (caller falls back); hard failure -> THROWS (never returns {error}, or
// src/mcp.ts resolveNestedError would mark execute failed).
//
// Splits + escrow come FROM the 402 terms (backend-computed via the FROZEN
// computeFlexSplits, serialized into accepts[0].extra). This module never
// imports backend flex.ts and never recomputes splits (AC4 by topology).
// The Ed25519 session-key signing is delegated to the SDK payment primitive
// payAndRetryFlex; the private key is owned by the wallet provider, never
// handled here.
import { X402_CONFIG } from "./index.js";
import { payAndRetryFlex, type FlexWalletLike } from "../../packages/sdk/src/flex.js";
import type { PaymentRequiredError } from "../../packages/sdk/src/errors.js";
import type { FlexPaymentRequired, FlexAcceptEntry } from "../../backend/src/services/flex-payment-terms.js";
import type { FlexSplit } from "../../backend/src/services/flex.js";

export interface FlexSettleResult<T = unknown> {
  data: T;
  settled: true;
  // The authorization actually signed + submitted. Its splits MUST be the
  // verbatim 402-terms splits (frozen, backend-computed); behaviorally pinned
  // by tests/flex-settlement.test.ts so a recompute cannot pass.
  authorization: { escrow: string; authorizationId: string; splits: FlexSplit[] };
}

/**
 * Resolve a provisioned Flex wallet (escrow + Ed25519 session key) from the
 * declared config. Returns null when none is provisioned, keeping the
 * on-chain signing path dormant and the seam a clean no-op (caller falls
 * back). Escrow funding needs a human at the hosted approval URL, so a fresh
 * machine has none: this honestly returns null rather than fake one.
 */
export function getFlexWallet(): FlexWalletLike | null {
  const escrow = process.env.FLEX_ESCROW_ADDRESS?.trim();
  const sessionKey = process.env.FLEX_SESSION_KEY_ADDRESS?.trim();
  if (!escrow || !sessionKey) return null;
  // The signer is delegated to the lobster/crossmint wallet that owns the
  // session key; we never see the private key. Wired when a provisioned
  // wallet exists (Step beyond wave-1 / human-funded escrow).
  return null;
}

/** The single facilitator URL, from the declared config. Never a literal. */
export function flexFacilitatorUrl(): string {
  return X402_CONFIG.facilitator;
}

function extractFlexAccept(terms: unknown): FlexAcceptEntry | null {
  const accepts = (terms as FlexPaymentRequired | undefined)?.accepts;
  if (!Array.isArray(accepts)) return null;
  return (accepts.find(
    (a): a is FlexAcceptEntry => (a as { scheme?: string }).scheme === "@faremeter/flex",
  ) ?? null);
}

/**
 * Settle a 402 via Faremeter Flex through the configured PayAI facilitator
 * and retry. splits + escrow come FROM the 402 terms (frozen). Returns null
 * when not a Flex 402 or no provisioned wallet (caller falls back); throws
 * on a hard settle failure; never returns an {error} object.
 */
export async function settleViaFlex<T = unknown>(
  url: string,
  terms: unknown,
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
    // Surface-supplied transport for the paid retry. CLI omits it (default
    // network fetch to url); MCP injects through its in-process Fastify app,
    // since the 402 bubbled through app.inject and a raw fetch would lose
    // the route/client-id/auth shaping. The money logic (authorize, sign,
    // submit, splits-verbatim) stays here; only the dumb transport varies
    // per surface. Coherent seam, not a fork.
    retry?: (paymentHeader: string) => Promise<T>;
  },
): Promise<FlexSettleResult<T> | null> {
  const accept = extractFlexAccept(terms);
  if (!accept) return null;
  const wallet = getFlexWallet();
  if (!wallet) return null;

  const draft = accept.extra.flexAuthorizationDraft;
  const splits: FlexSplit[] = accept.extra.splits;

  // Map the 402 envelope to the SDK PaymentRequiredError shape. The SDK
  // gates on extra.{escrow,splits} shape and uses requirement.maxAmountRequired;
  // splits are threaded verbatim into buildFlexAuthorization (frozen).
  const err = {
    accepts: [
      {
        maxAmountRequired: accept.amount,
        extra: {
          escrow: draft.escrow,
          splits,
          expiresAtSlot: draft.expiresAtSlot,
          facilitator: flexFacilitatorUrl(),
        },
      },
    ],
  } as unknown as PaymentRequiredError;

  const defaultRetry = async (paymentHeader: string): Promise<T> => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-PAYMENT": paymentHeader,
        ...(options?.headers ?? {}),
      },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    if (!res.ok) throw new Error(`flex retry HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  const data = await payAndRetryFlex<T>(err, wallet, options?.retry ?? defaultRetry);

  return {
    data,
    settled: true,
    authorization: {
      escrow: draft.escrow,
      authorizationId: draft.authorizationId,
      splits, // verbatim 402-terms splits (frozen); never recomputed
    },
  };
}
