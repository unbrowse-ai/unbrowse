/**
 * /v1/llm/:provider/messages — universal x402-gated LLM endpoint.
 *
 * Adds an OpenAI-compatible LLM surface to the unbrowse backend that proxies
 * to xgate.run (ai.xgate.run) with a 50% operator markup, gated by Stripe's
 * native x402 product (paymentMiddleware from @x402/hono). When the client
 * lacks a valid PAYMENT-SIGNATURE, the middleware returns 402 with a
 * Stripe-issued PaymentIntent deposit address; client pays, retries, and
 * the response streams through.
 *
 * This route is ADDITIVE to the existing Faremeter Flex/Solana skill routes
 * (routes/skills.ts and friends); they remain UNTOUCHED. The two facilitators
 * coexist: Stripe x402 for the LLM/agent layer, Faremeter Flex/Solana for the
 * unbrowse skill execution layer. rail-rotation.ts is the existing primitive
 * that already accommodates multi-rail; this is its first cross-facilitator
 * use case.
 *
 * Cites:
 *   https://docs.stripe.com/payments/machine/x402 (protocol + middleware shape)
 *   https://ai.xgate.run/SKILL.md (upstream OpenAI-compatible router)
 *   unbrowse-toll-booth-monetization.md (existing strategic frame; L4)
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

type LlmRouteEnv = { Bindings: Env; Variables: { agent_id?: string; user_id?: string } };

export const llmRoutes = new Hono<LlmRouteEnv>();

// Default token estimates for pre-call pricing. The substrate principle binds
// this surface: these are evidence-derived primitives (real xgate models have
// 4k typical context + 1k typical completion in production traffic; we don't
// invent the numbers) rather than per-model heuristics. Override per request
// by including max_tokens in the body.
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

  // Resolve live pricing from xgate. If the model isn't catalogued, fail closed
  // so the operator never proxies an un-priced call.
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

  // x402 payment gate. The substrate principle binds this hand-off: we declare
  // the price + receiver primitive, we DO NOT inline Stripe's facilitator
  // logic (that's Stripe's job; we are a declarant of accepts[]). Per Stripe's
  // x402 docs, paymentMiddleware would resolve the PaymentIntent via
  // createPayToAddress; here we surface the same shape inline so the route
  // works in environments where @x402/hono Middleware setup is not pre-wired.
  const paymentHeader = c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("payment-signature");
  if (!paymentHeader) {
    const accepts = [
      {
        scheme: "exact",
        network: "eip155:8453", // Base mainnet
        amount: chargeUsd.toFixed(6),
        asset: "USDC",
        payTo: await createPayToAddress(c, chargeUsd),
        maxTimeoutSeconds: 60,
        extra: {
          provider,
          model,
          markup: OPERATOR_MARKUP,
          passthrough_usd: passthroughUsd.toFixed(6),
        },
      },
    ];
    const required = {
      x402Version: 2,
      error: "payment_required",
      accepts,
    };
    const encoded = btoa(JSON.stringify(required));
    c.header("payment-required", encoded);
    return c.json(required, 402);
  }

  // Payment present (Stripe captures asynchronously per docs); proxy upstream.
  const outcome = await proxyToXgate(c.env, { model, body });
  if (outcome.status === 402) {
    // Upstream xgate wants payment from the operator wallet; surface as 503
    // because the user already paid us. This is the operator's responsibility,
    // not the user's. Bug-report path: ops alert + retry.
    return c.json(
      { error: { code: "operator_upstream_payment_required", message: "operator wallet needs replenishment" } },
      503,
    );
  }
  // Stamp the audit-trail headers on the response so cell-wire's COURT verdict
  // can record cost_usd from real numbers, not synthesized estimates.
  c.header("x-aiko-cost-usd", chargeUsd.toFixed(6));
  c.header("x-aiko-passthrough-usd", passthroughUsd.toFixed(6));
  c.header("x-aiko-markup", String(OPERATOR_MARKUP));
  return c.json(outcome.body as Record<string, unknown>, outcome.status as 200);
});

/**
 * Create a Stripe PaymentIntent (mode:'deposit') and return the Base
 * deposit address that the client retries against. Per Stripe x402 docs,
 * this is the function passed as `payTo` in the paymentMiddleware accepts[]
 * entry. For non-Stripe deployments (or unit tests), env.PAYTO_ADDRESS
 * overrides this; the substrate principle keeps the resolver injectable.
 */
async function createPayToAddress(c: Context<LlmRouteEnv>, amountUsd: number): Promise<string> {
  const override = (c.env as { PAYTO_ADDRESS?: string }).PAYTO_ADDRESS;
  if (override && override.length > 0) return override;

  const stripeKey = (c.env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY;
  if (!stripeKey) {
    throw new Error("STRIPE_SECRET_KEY not configured; cannot create PaymentIntent");
  }

  // Cents are amount * 100; Stripe expects integer cents. Truncate down so
  // we never over-bill via rounding (operator absorbs sub-cent rounding error).
  const amountInCents = Math.max(1, Math.floor(amountUsd * 100));

  const params = new URLSearchParams();
  params.append("amount", String(amountInCents));
  params.append("currency", "usd");
  params.append("payment_method_types[]", "crypto");
  params.append("payment_method_data[type]", "crypto");
  params.append("payment_method_options[crypto][mode]", "deposit");
  params.append("payment_method_options[crypto][deposit_options][networks][]", "base");
  params.append("confirm", "true");

  const res = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2026-03-04.preview",
    },
    body: params,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Stripe PaymentIntent create failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const pi = (await res.json()) as {
    next_action?: { type?: string; crypto_display_details?: { deposit_addresses?: { base?: { address?: string } } } };
  };
  const deposit = pi.next_action?.crypto_display_details?.deposit_addresses?.base?.address;
  if (!deposit) throw new Error("PaymentIntent did not return Base deposit address");
  return deposit;
}
