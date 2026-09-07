/**
 * /v1/llm/:provider/messages — universal x402-gated LLM endpoint.
 *
 * v2 (post wave-144 pivot): facilitator is Faremeter Flex on Solana, NOT
 * Stripe x402. Reason: the operating Stripe account is SG-region; Stripe's
 * Stablecoins+Crypto / machine-payments is US-only (confirmed via P4+P5+P6
 * agent-browser dashboard inspection). Faremeter Flex is already wired in
 * unbrowse v6.16 (no US-business gate, mainnet Solana USDC, 50/35/15 splits)
 * so the pivot reuses the existing facilitator instead of waiting on Stripe
 * Atlas + Delaware incorporation.
 *
 * Upstream: ai.xgate.run (OpenAI-compatible, Base USDC + ERC-2612 permits,
 * <5ms overhead, multi-provider catalog). Operator wallet bridges Base/Solana:
 * pays xgate.run in Base USDC permits; charges users in Solana USDC via Flex
 * with 50% markup; off-chain reconciliation.
 *
 * Cites:
 *   https://ai.xgate.run/SKILL.md (upstream router)
 *   unbrowse/backend/src/services/flex-route-helpers.ts (Flex facilitator)
 *   P6 (20260520T104814Z-ad127adc): dashboard-state-check precondition
 *   wave-144 of universal-x402-hidden-entry-point-across-web-unb harness
 */

import { Hono, type Context } from "hono";
import type { Env } from "../types.js";
import {
  resolveModelPricing,
  estimatePassthroughUsd,
  operatorChargeUsd,
  proxyToXgate,
  OPERATOR_MARKUP,
} from "../services/xgate.js";
import {
  sponsorAcceptsForPriceUsd,
  handleFlexPaymentAuthorized,
} from "../services/flex-route-helpers.js";
import { debitUserCredits, addUserCredits, UC_PER_USD } from "../services/user-credits.js";
import type { AutoRefillResult } from "../services/stripe.js";

type LlmRouteEnv = { Bindings: Env; Variables: { agent_id?: string; user_id?: string } };

export const llmRoutes = new Hono<LlmRouteEnv>();

// Default token estimates for pre-call pricing. Substrate-faithful: declared
// constants, not per-model heuristics. Override per request via body.max_tokens.
const DEFAULT_PROMPT_TOKEN_ESTIMATE = 4_000;
const DEFAULT_OUTPUT_TOKEN_ESTIMATE = 1_000;

interface OpenAIRequestBody {
  model?: string;
  messages?: unknown[];
  max_tokens?: number;
  [k: string]: unknown;
}

llmRoutes.post("/:provider/messages", async (c: Context<LlmRouteEnv>) => {
  const provider = c.req.param("provider");
  let body: OpenAIRequestBody;
  try {
    body = (await c.req.json()) as OpenAIRequestBody;
  } catch {
    return c.json({ error: { code: "invalid_body", message: "request body must be JSON" } }, 400);
  }

  const model = String(body.model ?? "");
  if (!model) {
    return c.json({ error: { code: "missing_model", message: "model is required" } }, 400);
  }

  const pricing = await resolveModelPricing(model);
  if (!pricing) {
    return c.json(
      { error: { code: "model_not_found", message: `unknown model: ${model}; see https://ai.xgate.run/v1/models` } },
      404,
    );
  }

  const promptTokens = DEFAULT_PROMPT_TOKEN_ESTIMATE;
  const outputTokens = typeof body.max_tokens === "number" ? body.max_tokens : DEFAULT_OUTPUT_TOKEN_ESTIMATE;
  const passthroughUsd = estimatePassthroughUsd(pricing, promptTokens, outputTokens);
  const chargeUsd = operatorChargeUsd(passthroughUsd);

  // ── Subscription credit lane (parallel to Flex x402) ──────────────────
  // If the caller presents a bearer key resolving to a user with unspent
  // monthly-plan credit, debit the micro-cent ledger and serve the call
  // directly — the subscription already paid for it, so x402 is skipped.
  // No key / no credit falls through to the anonymous Flex x402 path below,
  // unchanged. Optional-auth resolution mirrors skills.ts and never throws,
  // so the anonymous x402 contract is preserved exactly.
  const authzHeader = c.req.header("Authorization");
  if (authzHeader?.startsWith("Bearer ")) {
    try {
      const token = authzHeader.slice("Bearer ".length).trim();
      if (c.env.API_KEY && token === c.env.API_KEY) {
        c.set("agent_id", "__admin__");
      } else {
        const { verifyLocalKey } = await import("../services/keys.js");
        const { lookupUserIdByKey } = await import("../services/accounts.js");
        const verified = await verifyLocalKey(c.env, token);
        if (verified?.valid && verified.keyId) {
          c.set("agent_id", verified.keyId);
          const uid = await lookupUserIdByKey(c.env, verified.keyId).catch(() => null);
          if (uid) c.set("user_id", uid);
        }
      }
    } catch (err) {
      console.warn("[llm] optional auth lookup failed:", (err as Error).message);
    }
  }

  const userId = c.get("user_id");
  if (userId) {
    const chargeUc = Math.max(1, Math.round(chargeUsd * UC_PER_USD));

    // Serve a credit-funded call: proxy upstream, refund the debit on an
    // operator-side 402, stamp cost headers. Shared by the first debit and
    // the post-auto-refill retry so both paths behave identically.
    const serveFromCredit = async (
      balanceUc: number,
      refilledUsd?: number,
    ): Promise<Response> => {
      const outcome = await proxyToXgate(c.env, { model, body });
      if (outcome.status === 402) {
        // Operator wallet dry: refund so the subscriber is not charged for
        // an undelivered call, then surface the operator-side fault.
        await addUserCredits(c.env, userId, chargeUc).catch(() => {});
        return c.json(
          { error: { code: "operator_upstream_payment_required", message: "operator wallet needs replenishment" } },
          503,
        );
      }
      const resp = c.json(outcome.body as Record<string, unknown>, outcome.status as 200);
      resp.headers.set("x-aiko-cost-usd", chargeUsd.toFixed(6));
      resp.headers.set("x-aiko-passthrough-usd", passthroughUsd.toFixed(6));
      resp.headers.set("x-aiko-markup", String(OPERATOR_MARKUP));
      resp.headers.set("X-Unbrowse-Billing", `subscription balance_uc=${balanceUc}`);
      if (refilledUsd != null) {
        resp.headers.set("X-Unbrowse-Autorefill", `refilled amount_usd=${refilledUsd}`);
      }
      return resp;
    };

    const debit = await debitUserCredits(c.env, userId, chargeUc).catch((err) => {
      console.warn("[llm] debitUserCredits threw, falling through to x402:", (err as Error).message);
      return { ok: false as const, reason: "insufficient" as const };
    });
    if (debit.ok) {
      return serveFromCredit(debit.balance.balance_uc);
    }

    // Insufficient plan credit → auto-refill overage: charge the card on
    // file off-session, then retry the debit once. A declined card, a
    // missing payment method, the per-month cap, or a concurrent refill
    // already in flight all fall through cleanly to the Flex x402 path.
    if (debit.reason === "insufficient") {
      const { autoRefillUserCredits } = await import("../services/stripe.js");
      const refill: AutoRefillResult = await autoRefillUserCredits(c.env, userId).catch(
        (err) => {
          console.warn("[llm] autoRefillUserCredits threw:", (err as Error).message);
          return { ok: false, reason: "charge_failed" } as AutoRefillResult;
        },
      );
      if (refill.ok) {
        const retry = await debitUserCredits(c.env, userId, chargeUc).catch(() => null);
        if (retry?.ok) {
          return serveFromCredit(retry.balance.balance_uc, refill.amount_usd);
        }
      }
    }
    // No credit and no successful refill → fall through to the Flex x402
    // path below, unchanged.
  }

  // Faremeter Flex path: when the request lacks an X-PAYMENT header, return
  // a 402 with the sponsor-accepts envelope (single payee, platform wallet,
  // Solana USDC). When the header is present, verify+execute through the
  // shared helper which dispatches to the Flex facilitator.
  const payment = c.req.header("X-PAYMENT") ?? c.req.header("x-payment");
  if (!payment) {
    const operatorWallet = (c.env as { PAYMENT_RECIPIENT?: string }).PAYMENT_RECIPIENT
      ?? (c.env as { PAYTO_ADDRESS?: string }).PAYTO_ADDRESS
      ?? "";
    if (!operatorWallet) {
      return c.json(
        { error: { code: "operator_wallet_missing", message: "PAYMENT_RECIPIENT not configured on this Worker" } },
        503,
      );
    }
    const feePayer = (c.env as { PAYAI_FEEPAYER_PUBKEY?: string }).PAYAI_FEEPAYER_PUBKEY?.trim();
    const accepts = sponsorAcceptsForPriceUsd(chargeUsd, operatorWallet, feePayer || undefined);
    const required = {
      x402Version: 2,
      error: "payment_required",
      // Top-level `resource` object is REQUIRED by x402PaymentRequiredResponse
      // (@faremeter/types x402v2); without it a real exact-scheme client throws
      // "resource must be an object (was missing)" before it can sign.
      resource: {
        url: c.req.url,
        description: `LLM access: ${provider}/${model}`,
        mimeType: "application/json",
      },
      accepts,
      facilitator: "faremeter-flex-solana",
      extra: {
        provider,
        model,
        markup: OPERATOR_MARKUP,
        passthrough_usd: passthroughUsd.toFixed(6),
      },
    };
    return c.json(required, 402, {
      "PAYMENT-REQUIRED": btoa(JSON.stringify(required)),
    });
  }

  // X-PAYMENT present: hand off to the shared Flex verifier. It parses,
  // verifies via the Flex facilitator, runs executeFn, then settles + flushes.
  return handleFlexPaymentAuthorized(c, payment, {
    executeFn: async () => {
      const outcome = await proxyToXgate(c.env, { model, body });
      if (outcome.status === 402) {
        return c.json(
          { error: { code: "operator_upstream_payment_required", message: "operator wallet needs replenishment" } },
          503,
        );
      }
      const resp = c.json(outcome.body as Record<string, unknown>, outcome.status as 200);
      resp.headers.set("x-aiko-cost-usd", chargeUsd.toFixed(6));
      resp.headers.set("x-aiko-passthrough-usd", passthroughUsd.toFixed(6));
      resp.headers.set("x-aiko-markup", String(OPERATOR_MARKUP));
      return resp;
    },
  });
});
