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

// PayAI's Solana feePayer pubkey (from facilitator.payai.network/supported).
// The exact-scheme client (e.g. @faremeter/payment-solana/exact) reads this from
// `accept.extra.feePayer` to set the on-chain fee payer; PayAI submits + pays SOL.
// Mirror of the default in flex-payment-terms.ts; env-overridable at the call site.
export const PAYAI_FEEPAYER_DEFAULT = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";

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
      agentId: opts.agentId,
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
 * Exact-scheme accepts[] entry for a price. x402-v2 + faremeter compliant:
 * `extra.feePayer` lets an external exact-scheme client (e.g.
 * @faremeter/payment-solana/exact) build the SPL TransferChecked with PayAI as
 * the on-chain fee payer, so a real client can self-pay this 402 — not only the
 * platform `maybeSponsor` middleware (which still reads `term.amount`/`payTo`
 * unchanged). MUST be paired with a top-level `resource` object on the 402
 * envelope, which `x402PaymentRequiredResponse` requires for the client to parse.
 */
export function sponsorAcceptsForPriceUsd(
  priceUsd: number,
  creatorWallet: string,
  feePayer: string = PAYAI_FEEPAYER_DEFAULT,
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
      extra: {
        feePayer,
        facilitator: "https://facilitator.payai.network",
      },
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

  // Scheme dispatch: a Flex 402 envelope now offers two accepts entries
  // (Flex + exact-via-PayAI; see `flex-payment-terms.ts::buildFlexPaymentTerms`).
  // Clients echo their chosen scheme in the X-PAYMENT payload's top-level
  // `scheme` field per x402v2. If exact-on-Solana, we delegate verify+settle
  // to PayAI's facilitator over HTTP rather than the self-hosted Flex
  // facilitator. Splits do not apply on this path — the full amount went to
  // platformRecipientUsdcAta via the exact-scheme `payTo`.
  const declaredScheme = (payload as { scheme?: unknown }).scheme;
  if (declaredScheme === "exact") {
    // L2 telemetry: which rail the client dispatched on, so we can A/B
    // fill rate + latency by rail. Set BEFORE the handler so a thrown
    // executeFn still surfaces the rail attempted.
    c.header("X-Unbrowse-Rail-Hint", "payai");
    return handleExactPaymentViaPayAI(c, payload as Record<string, unknown>, opts);
  }
  c.header("X-Unbrowse-Rail-Hint", "flex");

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

/**
 * Exact-scheme payment handler: delegates verify + settle to PayAI's
 * facilitator over HTTP. Called from `handleFlexPaymentAuthorized` when
 * the client's X-PAYMENT picks the exact-on-Solana accept entry from
 * the dual-accept 402 envelope.
 *
 * PayAI's facilitator is at `https://facilitator.payai.network` and
 * implements the standard x402 facilitator HTTP interface:
 *   POST /verify  { x402Version, paymentPayload, paymentRequirements }
 *   POST /settle  { x402Version, paymentPayload, paymentRequirements }
 *
 * Both return `{ isValid, transaction?, network?, payer? }`-shaped JSON
 * per x402v2 facilitator spec.
 *
 * The merchant's existing splits cut does NOT apply on the exact path:
 * the 402 envelope's exact entry sets `payTo` to
 * `platformRecipientUsdcAta(env)` directly, so 100% of the payment is
 * already routed to Lewis's treasury USDC ATA. Contributors are not
 * paid through this path — clients who want contributor distribution
 * must pick the Flex accept entry.
 */
async function handleExactPaymentViaPayAI(
  c: AnyContext,
  payload: Record<string, unknown>,
  opts: { executeFn: () => Promise<Response> },
): Promise<Response> {
  const facilitatorUrl = (
    (payload?.extra as Record<string, unknown> | undefined)?.facilitator as string | undefined
  )?.trim() || "https://facilitator.payai.network";

  // Find the matching exact accept entry from the original 402 envelope.
  // The client echoes which entry it picked via `paymentRequirements`,
  // but for simplicity we reconstruct: scheme=exact, network=solana.
  const paymentRequirements = (payload.accepted ?? payload.paymentRequirements ?? {}) as Record<
    string,
    unknown
  >;

  const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements,
    }),
  }).catch((err: unknown) => {
    console.warn(`[payai] verify HTTP failed: ${(err as Error).message}`);
    return null;
  });

  if (!verifyRes || !verifyRes.ok) {
    return c.json(
      {
        error: "payai_verify_failed",
        reason: verifyRes ? `http_${verifyRes.status}` : "network_error",
      },
      402,
    );
  }
  const verifyBody = (await verifyRes.json().catch(() => null)) as
    | { isValid?: boolean; invalidReason?: string }
    | null;
  if (!verifyBody || verifyBody.isValid !== true) {
    return c.json(
      {
        error: "payai_verify_failed",
        reason: verifyBody?.invalidReason ?? "verify_returned_invalid",
      },
      402,
    );
  }

  const response = await opts.executeFn();

  const settleRes = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements,
    }),
  }).catch((err: unknown) => {
    console.warn(`[payai] settle HTTP failed: ${(err as Error).message}`);
    return null;
  });

  if (settleRes?.ok) {
    const settleBody = (await settleRes.json().catch(() => null)) as
      | { success?: boolean; transaction?: string; network?: string }
      | null;
    if (settleBody?.success && settleBody.transaction) {
      response.headers.set(
        "PAYMENT-RESPONSE",
        encodeBase64Json({
          transaction: settleBody.transaction,
          network: settleBody.network ?? "solana-mainnet-beta",
        }),
      );
    }
  } else if (settleRes) {
    console.warn(`[payai] settle returned ${settleRes.status}`);
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
