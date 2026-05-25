/**
 * Generic x402 wallet adapter factory.
 *
 * Contracts:
 *   - 699bd522 (wallet-framework-agnostic with lobster as reference)
 *   - 5451d944 (WALLET-IS-IDENTITY-NOT-API-KEY)
 *   - f5d491b1 (WALLET-ADAPTER-EXPANSION-FANOUT parent)
 *
 * Per the lobster.cash compatibility guide (86831ef1), every wallet adapter
 * has the SAME shape: isAvailable() precheck + payAndRetry() forward-to-
 * backend. The provider-specific bits (precheck path, backend endpoint URL,
 * auth header) live in a per-provider config record; the rest is identical
 * across all adapters.
 *
 * This factory generates a (isAvailable, payAndRetry) pair from a
 * ProviderConfig. New adapters add ONE config entry — no boilerplate
 * adapter file per provider.
 *
 * Endpoint URLs are marked TBD per contract c0c089e2 (the wave-27
 * privy-pay mistake — don't pretend an endpoint exists when it doesn't).
 * Backend wires the canonical x402-payment surface per provider in the
 * next-wave server coordination.
 *
 * NOT WIRED into client/index.ts dispatch yet — see src/client/index.ts
 * provider-switch for the existing hard-coded paysh + privy + lobster
 * arms. Migration path: replace those arms with this factory's output
 * once peer-coordinated backend endpoints are confirmed.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ProviderName =
  | "lobster_cash"
  | "pay_sh"
  | "privy_embedded"
  | "fluxa_agent"
  | "coinbase_agentic"
  | "okx_onchainos"
  | "circle_usdc"
  | "venice_x402"
  | "moonpay_x402"
  | "bankr_sdk"
  // Wave-32 expansion: more 402-payment providers (wallets + facilitators).
  | "agentcash_dev"
  | "corbits_onramp"
  | "ruflo_agentic"
  | "stellar_agentic"
  | "coinbase_monetize"
  | "external_solana";

export interface ProviderConfig {
  /** Provider key matching PaymentProvider in src/config/payment-provider.ts. */
  readonly name: ProviderName;

  /** Human label for log lines. */
  readonly label: string;

  /** Local availability check — does the user have this provider configured? */
  readonly precheck: () => boolean;

  /**
   * Backend x402-payment endpoint path. Marked TBD per peer coordination —
   * the canonical endpoint name is server-side-bound. Until reconciled, the
   * adapter forwards to this path and returns null on 404, letting the
   * client fall through to the next provider in the chain.
   */
  readonly endpointPath: string;

  /** Install-count for ranking purposes (informational, not enforcement). */
  readonly skill_install_count?: number;

  /** Contract id this adapter implements. */
  readonly contract_id: string;
}

/**
 * Build a (isAvailable, payAndRetry) pair from a ProviderConfig. The
 * returned shape mirrors src/payments/lobster-pay.ts API parity so the
 * client dispatch can route to any adapter via the same calling code.
 */
export function makeX402Adapter(config: ProviderConfig) {
  function isAvailable(): boolean {
    try {
      return config.precheck();
    } catch {
      return false;
    }
  }

  async function payAndRetry<T = unknown>(
    fullUrl: string,
    options?: {
      body?: unknown;
      headers?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<{ data: T; paid: true } | null> {
    if (!isAvailable()) {
      console.log(`[${config.name}] not configured — skipping`);
      return null;
    }
    console.log(`[${config.name}] attempting x402 payment for ${fullUrl}`);
    const backendUrl = process.env.UNBROWSE_BACKEND_URL || "https://beta-api.unbrowse.ai";
    const timeout = options?.timeoutMs ?? 30_000;
    try {
      const res = await fetch(`${backendUrl}${config.endpointPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options?.headers ?? {}),
        },
        body: JSON.stringify({
          invoice_url: fullUrl,
          provider: config.name,
          body: options?.body ?? null,
        }),
        signal: AbortSignal.timeout(timeout + 5_000),
      });
      if (!res.ok) {
        // 404 = backend hasn't wired this provider's endpoint yet (per
        // peer coordination). Caller falls through to next provider.
        if (res.status === 404) {
          console.log(`[${config.name}] backend endpoint not yet wired (404) — falling through`);
          return null;
        }
        const errBody = await res.text();
        console.warn(`[${config.name}] backend returned ${res.status}: ${errBody.slice(0, 200)}`);
        return null;
      }
      const result = await res.json() as { data?: T; paid?: boolean; error?: string };
      if (result.error) {
        console.warn(`[${config.name}] payment failed: ${result.error}`);
        return null;
      }
      if (!result.paid || result.data === undefined) {
        console.warn(`[${config.name}] backend did not return a paid result`);
        return null;
      }
      console.log(`[${config.name}] payment successful`);
      return { data: result.data, paid: true };
    } catch (err) {
      console.warn(`[${config.name}] error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  return { isAvailable, payAndRetry };
}

/**
 * Provider registry — one entry per adapter. Adding an adapter means
 * adding a row here + an entry in PaymentProvider type +
 * src/client/index.ts dispatch (one line each).
 */
export const PROVIDER_REGISTRY: readonly ProviderConfig[] = [
  {
    name: "fluxa_agent",
    label: "Fluxa agent wallet (MCP)",
    precheck: () => existsSync(join(process.env.HOME || homedir(), ".fluxa", "wallet.json")),
    endpointPath: "/v1/payments/fluxa/x402",
    skill_install_count: 8600,
    contract_id: "eb7e53fc",
  },
  {
    name: "coinbase_agentic",
    label: "Coinbase agentic wallet",
    precheck: () => existsSync(join(process.env.HOME || homedir(), ".coinbase", "agent.json")),
    endpointPath: "/v1/payments/coinbase/x402",
    skill_install_count: 3000,
    contract_id: "5312f708",
  },
  {
    name: "okx_onchainos",
    label: "OKX onchainos x402",
    precheck: () => existsSync(join(process.env.HOME || homedir(), ".okx", "session.json")),
    endpointPath: "/v1/payments/okx/x402",
    skill_install_count: 3800,
    contract_id: "72d7528d",
  },
  {
    name: "circle_usdc",
    label: "Circle USDC (issuer-routed)",
    precheck: () => !!process.env.CIRCLE_API_KEY,
    endpointPath: "/v1/payments/circle/x402",
    skill_install_count: 412,
    contract_id: "8a14de18",
  },
  {
    name: "venice_x402",
    label: "Venice x402",
    precheck: () => existsSync(join(process.env.HOME || homedir(), ".venice", "session.json")),
    endpointPath: "/v1/payments/venice/x402",
    skill_install_count: 43,
    contract_id: "b68595ad",
  },
  {
    name: "moonpay_x402",
    label: "MoonPay x402 (fiat-on-ramp)",
    precheck: () => !!process.env.MOONPAY_API_KEY,
    endpointPath: "/v1/payments/moonpay/x402",
    skill_install_count: 32,
    contract_id: "1697073d",
  },
  {
    name: "bankr_sdk",
    label: "Bankr x402 SDK",
    precheck: () => existsSync(join(process.env.HOME || homedir(), ".bankr", "session.json")),
    endpointPath: "/v1/payments/bankr/x402",
    skill_install_count: 290,
    contract_id: "f0fc502d",
  },
  // Wave-32 additions.
  {
    name: "agentcash_dev",
    label: "agentcash.dev wallet (x402-native)",
    precheck: () => existsSync(join(process.env.HOME || homedir(), ".agentcash", "wallet.json")),
    endpointPath: "/v1/payments/agentcash/x402",
    skill_install_count: 0, // not on skills.sh; tracked by Lewis as alt to lobster.cash
    contract_id: "5ee941f3",
  },
  {
    name: "corbits_onramp",
    label: "Corbits.dev card-to-x402 onramp (facilitator)",
    precheck: () => !!process.env.CORBITS_API_KEY,
    endpointPath: "/v1/payments/corbits/x402",
    skill_install_count: 0, // facilitator, not skill-listed
    contract_id: "07d7fc0b",
  },
  {
    name: "ruflo_agentic",
    label: "Ruflo agentic payments",
    precheck: () => existsSync(join(process.env.HOME || homedir(), ".ruflo", "agent.json")),
    endpointPath: "/v1/payments/ruflo/x402",
    skill_install_count: 499,
    contract_id: "dde8a2b1",
  },
  {
    name: "stellar_agentic",
    label: "Stellar agentic payments (XLM/USDC)",
    precheck: () => !!process.env.STELLAR_SECRET_KEY,
    endpointPath: "/v1/payments/stellar/x402",
    skill_install_count: 14,
    contract_id: "c0c715f3",
  },
  {
    name: "coinbase_monetize",
    label: "Coinbase monetize-service (x402 receive-side)",
    precheck: () => !!process.env.COINBASE_MONETIZE_API_KEY,
    endpointPath: "/v1/payments/coinbase-monetize/x402",
    skill_install_count: 2900,
    contract_id: "49ae6384",
  },
];

export function providerByName(name: ProviderName): ProviderConfig | undefined {
  return PROVIDER_REGISTRY.find((p) => p.name === name);
}

export function adapterByName(name: ProviderName) {
  const cfg = providerByName(name);
  if (!cfg) return null;
  return makeX402Adapter(cfg);
}
