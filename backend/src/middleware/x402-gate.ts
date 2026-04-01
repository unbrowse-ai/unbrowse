/**
 * x402 payment gating middleware — issue #33
 *
 * Implements the HTTP 402 Payment Required flow via Corbits facilitator.
 * Supports both Solana and Base chains with USDC settlement.
 *
 * Flow:
 *   1. Client requests a gated resource
 *   2. Server returns HTTP 402 with X-Payment-Required header containing payment terms
 *   3. Client pays via Corbits facilitator
 *   4. Client retries with X-Payment-Proof header
 *   5. Server verifies proof via facilitator and returns the resource
 *
 * Graceful degradation: if Corbits is unreachable, log the error and allow
 * the request through — never block the entire system on facilitator downtime.
 */

import type { Context } from "hono";

// ─── Constants ────────────────────────────────────────────────────────────────

const CORBITS_FACILITATOR_URL = "https://facilitator.corbits.dev";
const VERIFY_TIMEOUT_MS = 5_000;

// ─── Supported chains ─────────────────────────────────────────────────────────

export interface ChainConfig {
  network: string;
  asset: string;
  /** Production network name */
  mainnet: string;
  /** Test network name */
  testnet: string;
}

export const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  solana: {
    network: "solana",
    asset: "USDC",
    mainnet: "solana-mainnet",
    testnet: "solana-devnet",
  },
  base: {
    network: "base",
    asset: "USDC",
    mainnet: "base-mainnet",
    testnet: "base-sepolia",
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface X402Terms {
  /** Payment amount as a string (to avoid floating-point issues in JSON). */
  amount: string;
  /** Currency code, e.g. "USDC". */
  currency: string;
  /** Blockchain network, e.g. "solana-devnet" or "base-sepolia". */
  chain: string;
  /** Corbits facilitator endpoint for payment processing. */
  facilitator: string;
  /** Recipient wallet address for the payment. */
  recipient: string;
  /** The resource URI the payment unlocks. */
  resource: string;
  /** Optional human-readable memo / description. */
  memo?: string;
}

export interface X402MultiChainTerms {
  /** All accepted payment options — agents can pay on any supported chain. */
  accepts: X402Terms[];
}

// ─── 402 response helper ──────────────────────────────────────────────────────

/**
 * Return an HTTP 402 response with x402-compliant payment terms.
 * Includes payment options for ALL supported chains.
 */
export function x402Response(c: Context, terms: X402Terms | X402MultiChainTerms) {
  const body = "accepts" in terms
    ? { error: "Payment Required", ...terms }
    : { error: "Payment Required", terms };

  return c.json(body, 402, {
    "X-Payment-Required": JSON.stringify(terms),
  });
}

// ─── Proof verification ───────────────────────────────────────────────────────

/**
 * Verify a payment proof string via the Corbits facilitator.
 * Tries /settle first (x402 standard), falls back to /verify (legacy).
 */
export async function verifyX402Proof(proof: string): Promise<{ valid: boolean; degraded: boolean; transaction?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    const res = await fetch(`${CORBITS_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentHeader: proof }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (res.ok) {
      const body = await res.json() as Record<string, unknown>;
      return {
        valid: !!body.success,
        degraded: false,
        transaction: (body.transaction ?? body.txHash) as string | undefined,
      };
    }

    // Try legacy /verify endpoint
    const res2 = await fetch(`${CORBITS_FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proof }),
    });

    return { valid: res2.ok, degraded: false };
  } catch (err) {
    // Facilitator unreachable — graceful degradation: allow the request
    console.error("[x402] facilitator verification failed, degrading gracefully:", (err as Error).message);
    return { valid: true, degraded: true };
  }
}

// ─── Payment terms builder ────────────────────────────────────────────────────

/**
 * Build x402 payment terms for a skill access request.
 * Returns multi-chain terms so agents can pay on Solana OR Base.
 */
export function buildSkillPaymentTerms(
  priceUsd: number,
  skillId: string,
  recipient: string,
  resource: string,
  options?: {
    /** Additional per-chain recipients (e.g. different address for Base vs Solana) */
    recipients?: Record<string, string>;
    /** Force a specific chain instead of offering all */
    chain?: string;
    /** Use testnet networks */
    testnet?: boolean;
  },
): X402MultiChainTerms {
  const amount = priceUsd.toFixed(6);
  const memo = `Skill access: ${skillId}`;
  const useTestnet = options?.testnet ?? true; // Default to testnet for safety

  if (options?.chain) {
    const chainConfig = SUPPORTED_CHAINS[options.chain];
    if (!chainConfig) throw new Error(`Unsupported chain: ${options.chain}`);
    return {
      accepts: [{
        amount,
        currency: chainConfig.asset,
        chain: useTestnet ? chainConfig.testnet : chainConfig.mainnet,
        facilitator: CORBITS_FACILITATOR_URL,
        recipient: options?.recipients?.[options.chain] ?? recipient,
        resource,
        memo,
      }],
    };
  }

  // Offer ALL supported chains
  return {
    accepts: Object.entries(SUPPORTED_CHAINS).map(([chainName, config]) => ({
      amount,
      currency: config.asset,
      chain: useTestnet ? config.testnet : config.mainnet,
      facilitator: CORBITS_FACILITATOR_URL,
      recipient: options?.recipients?.[chainName] ?? recipient,
      resource,
      memo,
    })),
  };
}
