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
    const accepts = sponsorAcceptsForPriceUsd(chargeUsd, operatorWallet);
    const required = {
      x402Version: 2,
      error: "payment_required",
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
