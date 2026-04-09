/**
 * Payment integration — lobster.cash compatible.
 *
 * This module describes payment INTENT and requirements.
 * It does NOT implement wallet internals, generate wallets,
 * or hardcode wallet provider action names.
 *
 * Delegation boundary:
 * - Unbrowse owns: use-case intent, amount, recipient, memo
 * - Wallet provider (lobster.cash) owns: provisioning, signing, broadcast, status
 *
 * @see https://lobster.cash/docs/skill-compatibility-guide
 */

// ---------------------------------------------------------------------------
// Payment requirement — what unbrowse tells the agent/wallet
// ---------------------------------------------------------------------------

export interface PaymentRequirement {
  required: boolean;
  amount: string;
  currency: string;
  reason: string;
  recipient?: string;
  memo?: string;
}

export type PaymentStatus =
  | "paid"
  | "payment_required"
  | "wallet_not_configured"
  | "insufficient_balance"
  | "payment_failed"
  | "awaiting_confirmation"
  | "indexing_fallback"
  | "free";

export interface PaymentGateResult {
  status: PaymentStatus;
  requirement?: PaymentRequirement;
  message: string;
  next_step?: string;
}

// ---------------------------------------------------------------------------
// X402 configuration — Solana + Base, USDC via corbits.dev
// ---------------------------------------------------------------------------

export const X402_CONFIG = {
  chains: {
    solana: {
      network: "solana",
      currency: "USDC",
      testnet: "solana-devnet",
      mainnet: "solana-mainnet",
    },
    base: {
      network: "base",
      currency: "USDC",
      testnet: "base-sepolia",
      mainnet: "base-mainnet",
    },
  },
  facilitator: "https://facilitator.corbits.dev",
  supports_pda_wallets: true,
} as const;

// ---------------------------------------------------------------------------
// Dynamic pricing — fetch real route price from the backend
// ---------------------------------------------------------------------------

/** Backend API base URL for pricing queries. */
const PRICING_API_URL = process.env.UNBROWSE_BACKEND_URL ?? "https://beta-api.unbrowse.ai";

/** Maximum time (ms) to wait for dynamic price before falling back. */
const PRICING_TIMEOUT_MS = 2_000;

/** Default fallback price when backend is unreachable or slow (USD). */
const DEFAULT_PRICE_USD = "0.001";

/**
 * Fetch the dynamic route price for a skill from the backend.
 *
 * Calls GET /v1/skills/:id/price with a 2 s timeout.
 * Returns the price as a USD string, or null if the backend is
 * unavailable, slow, or returns an unexpected shape.
 *
 * Non-blocking: callers should fall back to DEFAULT_PRICE_USD on null.
 */
export async function fetchDynamicPrice(skillId: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRICING_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${PRICING_API_URL}/v1/skills/${encodeURIComponent(skillId)}/price`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const price = body?.price_usd;
    if (typeof price === "number" && price > 0) return String(price);
    if (typeof price === "string" && parseFloat(price) > 0) return price;
    return null;
  } catch {
    // Network error, timeout, or JSON parse failure — non-fatal.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Payment gate — determines if execution requires payment
// ---------------------------------------------------------------------------

/**
 * Check if a skill execution requires payment.
 * Returns a PaymentGateResult describing what the agent needs to do.
 *
 * Attempts to fetch the real dynamic price from the backend via
 * GET /v1/skills/:id/price. Falls back to DEFAULT_PRICE_USD ("0.001")
 * when the backend is unreachable, slow (>2 s), or returns an error.
 *
 * This function does NOT execute payments — it describes requirements.
 * The agent's wallet plugin (lobster.cash) handles actual payment.
 */
export async function checkPaymentRequirement(
  skillId: string,
  endpointId: string,
  options?: {
    price_usd?: string;
    skip_payment?: boolean;
    wallet_configured?: boolean;
  },
): Promise<PaymentGateResult> {
  if (options?.skip_payment || process.env.UNBROWSE_SKIP_PAYMENT === "1") {
    return { status: "free", message: "Payment skipped." };
  }

  if (skillId.startsWith("local:") || process.env.UNBROWSE_FREE_TIER === "1") {
    return { status: "free", message: "No payment required for local skills." };
  }

  // Resolve price: explicit override > dynamic backend price > hardcoded default
  let amount = options?.price_usd ?? null;
  if (amount === null) {
    const dynamic = await fetchDynamicPrice(skillId).catch(() => null);
    amount = dynamic ?? DEFAULT_PRICE_USD;
  }

  if (parseFloat(amount) <= 0) {
    return { status: "free", message: "No payment required." };
  }

  const requirement: PaymentRequirement = {
    required: true,
    amount,
    currency: "USDC",
    reason: `Per-query fee for ${skillId}/${endpointId}`,
    recipient: X402_CONFIG.facilitator,
    memo: `unbrowse:${skillId}:${endpointId}`,
  };

  if (options?.wallet_configured === false) {
    return {
      status: "wallet_not_configured",
      requirement,
      message: "No agent wallet configured. Set up a wallet like lobster.cash to use paid skills.",
      next_step: "Complete wallet setup before proceeding with this skill execution.",
    };
  }

  return {
    status: "payment_required",
    requirement,
    message: `This execution requires ${amount} USDC. Transaction execution and final status are handled by your wallet provider.`,
    next_step: "If a wallet step is required and wallet context is missing, complete wallet setup first.",
  };
}

/**
 * Interpret a payment result from the agent's wallet.
 * Maps wallet outcomes to gate decisions.
 */
/**
 * Interpret a payment result from the agent's wallet.
 * Maps wallet outcomes to gate decisions.
 *
 * When the wallet reports insufficient balance or no wallet,
 * the caller should use resolveUnpaidAccess() to determine
 * whether indexing fallback is available.
 */
export function interpretPaymentResult(
  walletStatus: string,
  requirement: PaymentRequirement,
): PaymentGateResult {
  switch (walletStatus) {
    case "confirmed":
    case "success":
    case "paid":
      return { status: "paid", requirement, message: "Payment confirmed. Proceeding with execution." };

    case "pending":
    case "processing":
      return {
        status: "awaiting_confirmation",
        requirement,
        message: "Payment is being processed. Wait for your wallet to report the final transaction status before continuing.",
      };

    case "insufficient_balance":
    case "insufficient_funds":
      return {
        status: "insufficient_balance",
        requirement,
        message: `Insufficient balance. Fund your wallet with at least ${requirement.amount} ${requirement.currency}, or fall back to indexing mode.`,
        next_step: "Fund your agent wallet and retry, or use resolveUnpaidAccess() to contribute indexing instead.",
      };

    case "wallet_not_configured":
    case "no_wallet":
      return {
        status: "wallet_not_configured",
        requirement,
        message: "No agent wallet configured. Falling back to indexing mode — you can contribute route indexing instead of paying.",
        next_step: "Set up lobster.cash to unlock paid execution, or continue in indexing mode.",
      };

    default:
      return {
        status: "payment_failed",
        requirement,
        message: `Payment failed: ${walletStatus}. You may retry or fall back to indexing mode.`,
        next_step: "Retry the payment, or use resolveUnpaidAccess() to contribute indexing instead.",
      };
  }
}

/**
 * Determine what an unpaid user can do.
 *
 * Users who can't pay (no wallet, insufficient balance, payment failed)
 * fall back to indexing mode: they can capture, reverse-engineer, and
 * index routes into the marketplace — contributing to the network
 * instead of consuming paid executions.
 *
 * This is the default behavior when payment is required but not available.
 */
export function resolveUnpaidAccess(
  gateResult: PaymentGateResult,
): PaymentGateResult {
  const cantPay = gateResult.status === "wallet_not_configured"
    || gateResult.status === "insufficient_balance"
    || gateResult.status === "payment_failed";

  if (!cantPay) return gateResult;

  return {
    status: "indexing_fallback",
    requirement: gateResult.requirement,
    message: "Indexing mode: you can capture and index routes for the marketplace. Paid execution requires a funded wallet.",
    next_step: "Use resolve with --force-capture to contribute new routes. Set up lobster.cash to unlock paid execution.",
  };
}
