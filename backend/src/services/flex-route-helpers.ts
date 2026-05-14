/**
 * Flex route helpers — shared bits between the priced routes (skills, demos,
 * search). All terms are emitted via `buildFlexPaymentTerms` and verified via
 * `createFlexFacilitator(env)`. The legacy Corbits codepath was removed in
 * v6.16 Phase 5 (Day-6, Genesis Dominion).
 *
 * Surface:
 *   - `respondWithFlexTerms` — load agent profile, fetch currentSlot, build
 *     and return the Flex 402 envelope. Defensive guards even though the
 *     P0.3 soft-block fires before this (no flex_escrow_address still gets a
 *     402 with `flex_escrow_required`).
 *   - `sponsorAcceptsForPriceUsd` — minimal accepts[] for the existing
 *     `maybeSponsor` middleware (Phase 4 / Day-6+ swaps sponsor onto Flex
 *     rails proper; the helper retires then).
 *   - `handleFlexPaymentAuthorized` — verify the signed FlexPaymentPayload,
 *     execute the skill (caller-supplied), settle the actual amount, and
 *     queue facilitator.flush() via waitUntil.
 */

import type { Context } from "hono";
import type { Env, SkillManifest } from "../types.js";
import {
  buildFlexPaymentTerms,
  type FlexPaymentRequired,
} from "./flex-payment-terms.js";
import { createFlexFacilitator } from "./flex-facilitator.js";
import { getAgent } from "./agents.js";
import type { X402PaymentRequirementV2 } from "../middleware/x402-gate.js";

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyContext = Context<{ Bindings: Env; Variables: any }>;

/**
 * Build a Flex 402 envelope and return it as the route's Response.
 *
 * The agent profile must carry `flex_escrow_address`; the P0.3 soft-block
 * normally fires first, but this is a defensive guard for routes whose
 * soft-block dispatch was skipped (anonymous calls, admin shortcut).
 */
export async function respondWithFlexTerms(
  c: AnyContext,
  opts: {
    skill: Pick<SkillManifest, "skill_id" | "contributors">;
    priceUsd: number;
    resource: string;
    agentId: string | undefined;
    /**
     * Overrides the description emitted in the Flex envelope's `resource`
     * field. Demo routes use this to surface tier info.
     */
    descriptionOverride?: string;
  },
): Promise<Response> {
  // No agent or admin path — soft-block doesn't apply; without an escrow
  // address we can't author a Flex authorization. Surface the gap explicitly.
  const escrow = opts.agentId && opts.agentId !== "__admin__"
    ? (await getAgent(c.env, opts.agentId).catch(() => null))?.flex_escrow_address
    : undefined;
  if (!escrow) {
    return c.json(
      {
        error: "flex_escrow_required",
        remediation: "Run `unbrowse setup` or pair via /account to fund a Flex escrow.",
      },
      402,
      { "X-Flex-Onboarding-Required": "1", "X-Flex-Missing": "flex_escrow_address" },
    );
  }

  const currentSlot = await currentSolanaSlot(c.env);

  let terms: FlexPaymentRequired;
  try {
    terms = await buildFlexPaymentTerms(c.env, {
      skill: opts.skill,
      priceUsd: opts.priceUsd,
      agentEscrow: escrow,
      resource: opts.resource,
      currentSlot,
    });
  } catch (err) {
    console.warn(`[flex] buildFlexPaymentTerms failed: ${(err as Error).message}`);
    return c.json({ error: "flex_terms_unavailable", reason: (err as Error).message }, 500);
  }

  if (opts.descriptionOverride) {
    terms.resource.description = opts.descriptionOverride;
  }

  // PAYMENT-REQUIRED + X-Payment-Required: keep parity with the previous emit
  // shape so generic 402-aware clients still parse the envelope. Body is the
  // Flex envelope directly per the v6.16 spec.
  return c.json(terms, 402, {
    "PAYMENT-REQUIRED": encodeBase64Json(terms),
    "X-Payment-Required": JSON.stringify(terms),
  });
}

/**
 * Minimal accepts[] entry purely so the existing `maybeSponsor` middleware can
 * read `term.amount` and `term.payTo` without changes. The sponsor middleware
 * pays the creator wallet directly today; Phase 4 / Day-6+ will rewrite it to
 * mint a sponsor-escrow-signed Flex authorization with platform recoup splits,
 * and this helper retires.
 */
export function sponsorAcceptsForPriceUsd(
  priceUsd: number,
  creatorWallet: string,
): X402PaymentRequirementV2[] {
  const amount = String(Math.max(1, Math.round(priceUsd * 1_000_000)));
  return [
    {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount,
      asset: USDC_MINT_MAINNET,
      payTo: creatorWallet,
      maxTimeoutSeconds: 300,
    },
  ];
}

/**
 * Handle a request that carries an `X-PAYMENT` Flex authorization header.
 * Parses the JSON payload, verifies via the Flex facilitator, runs the
 * caller-supplied `executeFn` to produce the route's response, then settles
 * the actual amount and queues facilitator.flush via c.executionCtx.waitUntil.
 *
 * Returns the executeFn's Response on settle success. On verify failure or
 * malformed payload returns a 402 with the failure reason.
 */
export async function handleFlexPaymentAuthorized(
  c: AnyContext,
  rawPayload: string,
  opts: {
    executeFn: () => Promise<Response>;
  },
): Promise<Response> {
  let payload: { accepted?: unknown; payload?: unknown } | null = null;
  try {
    payload = JSON.parse(rawPayload) as { accepted?: unknown; payload?: unknown };
  } catch {
    // Some agents emit base64-encoded JSON in X-PAYMENT — try decoding once.
    try {
      const decoded = typeof globalThis?.atob === "function"
        ? globalThis.atob(rawPayload)
        : Buffer.from(rawPayload, "base64").toString("utf8");
      payload = JSON.parse(decoded) as { accepted?: unknown; payload?: unknown };
    } catch {
      return c.json({ error: "flex_verify_failed", reason: "malformed_payload" }, 402);
    }
  }
  if (!payload || typeof payload !== "object") {
    return c.json({ error: "flex_verify_failed", reason: "malformed_payload" }, 402);
  }

  let facilitator;
  try {
    facilitator = await createFlexFacilitator(c.env);
  } catch (err) {
    console.warn(`[flex] facilitator unavailable: ${(err as Error).message}`);
    return c.json({ error: "flex_facilitator_unavailable", reason: (err as Error).message }, 503);
  }

  const requirements = payload.accepted ?? {};
  const signed = payload.payload ?? payload;

  const verifyResult = await facilitator.handler
    .handleVerify(requirements, signed)
    .catch((err: unknown) => {
      console.warn(`[flex] verify threw: ${(err as Error).message}`);
      return null;
    });

  if (!verifyResult || verifyResult.isValid !== true) {
    return c.json(
      {
        error: "flex_verify_failed",
        reason: verifyResult?.invalidReason ?? "verify_returned_null",
      },
      402,
    );
  }

  // Hold confirmed. Run the route handler.
  const response = await opts.executeFn();

  // Settle through the same handler. handleSettle returns the on-chain tx
  // signature (or null on facilitator-side failure). We don't block on this;
  // the hold is already in place, settlement runs to convergence in flush().
  const settleResult = await facilitator.handler
    .handleSettle(requirements, signed)
    .catch((err: unknown) => {
      console.warn(`[flex] settle threw: ${(err as Error).message}`);
      return null;
    });

  if (settleResult?.success && settleResult.transaction) {
    response.headers.set(
      "PAYMENT-RESPONSE",
      encodeBase64Json({ transaction: settleResult.transaction, network: settleResult.network }),
    );
  }

  // Fire-and-forget flush so settlements drain without blocking the response.
  try {
    (c as Context & { executionCtx: ExecutionContext }).executionCtx.waitUntil(
      facilitator.flush().catch((err) => {
        console.warn(`[flex] flush threw: ${(err as Error).message}`);
      }),
    );
  } catch {
    // No executionCtx in tests — flush will be drained on next call.
  }

  return response;
}

async function currentSolanaSlot(env: Env): Promise<bigint> {
  const rpcUrl = env.CASCADE_RPC_URL?.trim();
  if (!rpcUrl) {
    // No RPC wired (tests, local dev). Use a deterministic placeholder so the
    // authorization draft still validates; production sets CASCADE_RPC_URL.
    return 100_000n;
  }
  try {
    const kit = await import("@solana/kit");
    const rpc = kit.createSolanaRpc(rpcUrl);
    const slot = await rpc.getSlot().send();
    return typeof slot === "bigint" ? slot : BigInt(slot as unknown as number);
  } catch (err) {
    console.warn(`[flex] currentSolanaSlot RPC failed, using placeholder: ${(err as Error).message}`);
    return 100_000n;
  }
}

function encodeBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof globalThis?.btoa === "function") {
    // btoa expects a binary string; encode UTF-8 -> binary first.
    let binary = "";
    const bytes = new TextEncoder().encode(json);
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
  }
  return Buffer.from(json, "utf8").toString("base64");
}
