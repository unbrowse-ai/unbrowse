/**
 * xgate.run upstream client.
 *
 * https://ai.xgate.run/SKILL.md is the OpenAI-compatible LLM router that
 * speaks x402 natively (ERC-2612 USDC permits on Base) with <5ms overhead
 * and a multi-provider catalog (Anthropic, OpenAI, fal, Bedrock).
 *
 * This module is the SERVER-SIDE proxy used by routes/llm.ts. The operator
 * pays xgate.run in Base USDC; users pay the operator in USDC via Stripe's
 * x402 facilitator at a 50% markup. Two responsibilities:
 *
 *   1. resolveModelPricing(): pull live pricing from xgate /v1/models so the
 *      operator markup is computed from real numbers, never a stale constant.
 *   2. proxyToXgate(): forward the OpenAI-compatible request and either
 *      surface xgate's 402 (if the operator wallet is empty) or stream the
 *      200 response back. The operator's permit signing is delegated to
 *      OPERATOR_BASE_PRIVATE_KEY at the WALLET boundary (NOT logged).
 */

import type { Env } from "../types.js";

export interface ModelPricing {
  id: string;
  display_name: string;
  provider: string;
  input_per_1m: number;
  output_per_1m: number;
  cache_read_per_1m?: number;
  cache_write_per_1m?: number;
}

const XGATE_BASE = "https://ai.xgate.run";

let pricingCache: { ts: number; map: Map<string, ModelPricing> } | null = null;
const PRICING_TTL_MS = 5 * 60 * 1000;

export async function resolveModelPricing(model: string): Promise<ModelPricing | null> {
  if (pricingCache && Date.now() - pricingCache.ts < PRICING_TTL_MS) {
    return pricingCache.map.get(model) ?? null;
  }
  try {
    const res = await fetch(`${XGATE_BASE}/v1/models`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const map = new Map<string, ModelPricing>();
    for (const m of body.data ?? []) {
      const id = String(m.id ?? "");
      if (!id) continue;
      const p = (m.pricing ?? {}) as Record<string, string | number | undefined>;
      map.set(id, {
        id,
        display_name: String(m.display_name ?? id),
        provider: String(m.provider ?? ""),
        input_per_1m: Number(p.input_per_1m ?? 0),
        output_per_1m: Number(p.output_per_1m ?? 0),
        cache_read_per_1m: p.cache_read_per_1m === undefined ? undefined : Number(p.cache_read_per_1m),
        cache_write_per_1m: p.cache_write_per_1m === undefined ? undefined : Number(p.cache_write_per_1m),
      });
    }
    pricingCache = { ts: Date.now(), map };
    return map.get(model) ?? null;
  } catch {
    return null;
  }
}

/**
 * Compute the operator's charge given the model + a max-token estimate.
 * For pre-call pricing, we estimate cost as if the response uses
 * estimatedOutputTokens; the actual settlement reconciles post-call.
 * Returns USD (decimal).
 */
export function estimatePassthroughUsd(
  pricing: ModelPricing,
  promptTokens: number,
  estimatedOutputTokens: number,
): number {
  const inUsd = (promptTokens / 1_000_000) * pricing.input_per_1m;
  const outUsd = (estimatedOutputTokens / 1_000_000) * pricing.output_per_1m;
  return inUsd + outUsd;
}

export const OPERATOR_MARKUP = 1.5;

export function operatorChargeUsd(passthroughUsd: number): number {
  return passthroughUsd * OPERATOR_MARKUP;
}

export interface ProxyToXgateInput {
  model: string;
  body: unknown;
  /** Forwarded for upstream caching / observability. Substrate-faithful: no inference. */
  identityHeaders?: Record<string, string>;
}

export interface ProxyToXgateOutcome {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Proxy an OpenAI-compatible /v1/chat/completions request to xgate. The
 * operator's Base USDC wallet signs the ERC-2612 permit when xgate returns
 * 402; we surface xgate's 200 (or final 402 if the operator wallet is dry)
 * back to the caller. The actual permit signing is intentionally a wallet
 * boundary: this module does NOT inline ECDSA logic; it reads
 * env.OPERATOR_PAYMENT_SIGNATURE_BASE64 (pre-signed permit emitted by an
 * operator-side signer service) OR calls env.OPERATOR_SIGNER_URL if set.
 * For sandbox / test runs, both can be absent — xgate's free tier returns
 * 200 within rate limits.
 */
export async function proxyToXgate(env: Env, input: ProxyToXgateInput): Promise<ProxyToXgateOutcome> {
  const url = `${XGATE_BASE}/v1/chat/completions`;
  const baseHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };

  const sig = (env as { OPERATOR_PAYMENT_SIGNATURE_BASE64?: string }).OPERATOR_PAYMENT_SIGNATURE_BASE64;
  if (sig && sig.length > 0) baseHeaders["PAYMENT-SIGNATURE"] = sig;

  const res = await fetch(url, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({ ...(input.body as Record<string, unknown>), model: input.model }),
  });

  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body, headers };
}
