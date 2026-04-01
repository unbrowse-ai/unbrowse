/**
 * x402 payment gating middleware — issue #33
 *
 * Implements the HTTP 402 Payment Required flow via Corbits facilitator.
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

// ─── Types ────────────────────────────────────────────────────────────────────

export interface X402Terms {
  /** Payment amount as a string (to avoid floating-point issues in JSON). */
  amount: string;
  /** Currency code, e.g. "USDC". */
  currency: string;
  /** Blockchain network, e.g. "base-sepolia". */
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

// ─── 402 response helper ──────────────────────────────────────────────────────

/**
 * Return an HTTP 402 response with x402-compliant payment terms.
 * The terms are both in the JSON body and the X-Payment-Required header.
 */
export function x402Response(c: Context, terms: X402Terms) {
  return c.json(
    { error: "Payment Required", terms },
    402,
    { "X-Payment-Required": JSON.stringify(terms) },
  );
}

// ─── Proof verification ───────────────────────────────────────────────────────

/**
 * Verify a payment proof string via the Corbits facilitator.
 *
 * Returns `true` if the facilitator confirms the proof is valid.
 * Returns `true` (graceful degradation) if the facilitator is unreachable,
 * so that the system never blocks callers on facilitator downtime.
 */
export async function verifyX402Proof(proof: string): Promise<{ valid: boolean; degraded: boolean }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    const res = await fetch(`${CORBITS_FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proof }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    return { valid: res.ok, degraded: false };
  } catch (err) {
    // Facilitator unreachable — graceful degradation: allow the request
    console.error("[x402] facilitator verification failed, degrading gracefully:", (err as Error).message);
    return { valid: true, degraded: true };
  }
}

// ─── Payment terms builder ────────────────────────────────────────────────────

/**
 * Build x402 payment terms for a skill install/access request.
 */
export function buildSkillPaymentTerms(
  priceUsd: number,
  skillId: string,
  recipient: string,
  resource: string,
): X402Terms {
  return {
    amount: priceUsd.toFixed(6),
    currency: "USDC",
    chain: "base-sepolia",
    facilitator: CORBITS_FACILITATOR_URL,
    recipient,
    resource,
    memo: `Skill access: ${skillId}`,
  };
}
