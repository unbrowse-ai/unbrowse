import { DEFAULT_BACKEND_URL } from "../version.js";
import { getApiKey } from "../client/index.js";

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

export type PaymentMethod = "credits" | "x402" | "free" | "indexing";

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
  method?: PaymentMethod;
  balance_remaining_uc?: number;
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
// Credit balance — subsidized onboarding via backend credit ledger
// ---------------------------------------------------------------------------

/** Backend API base URL for credit queries. */
const CREDITS_API_URL = process.env.UNBROWSE_BACKEND_URL ?? DEFAULT_BACKEND_URL;

/** Credit balance cache: avoids hitting the backend on every call. */
let _creditBalanceCache: { balance_uc: number; earned_uc: number; fetched_at: number } | null = null;
const CREDIT_CACHE_TTL_MS = 60_000; // 60 seconds

/** Maximum time (ms) to wait for credit API before skipping. */
const CREDITS_TIMEOUT_MS = 2_000;

/**
 * Fetch agent credit balance from the backend.
 * Returns { balance_uc, earned_uc } in micro-cents, or null on failure.
 * Results are cached for 60s to avoid per-call overhead.
 */
export async function fetchCreditBalance(): Promise<{ balance_uc: number; earned_uc: number } | null> {
  // Return cached if fresh
  if (_creditBalanceCache && Date.now() - _creditBalanceCache.fetched_at < CREDIT_CACHE_TTL_MS) {
    return { balance_uc: _creditBalanceCache.balance_uc, earned_uc: _creditBalanceCache.earned_uc };
  }

  const apiKey = getApiKey();
  if (!apiKey || apiKey === "local-only") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREDITS_TIMEOUT_MS);
  try {
    const res = await fetch(`${CREDITS_API_URL}/v1/credits/balance`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const balance_uc = typeof body?.balance_uc === "number" ? body.balance_uc : 0;
    const earned_uc = typeof body?.earned_uc === "number" ? body.earned_uc : 0;
    _creditBalanceCache = { balance_uc, earned_uc, fetched_at: Date.now() };
    return { balance_uc, earned_uc };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Debit credits from the agent's balance.
 * Returns the remaining balance in micro-cents, or null on failure.
 */
export async function debitCredits(amount_uc: number): Promise<{ balance_uc: number; earned_uc: number } | null> {
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "local-only") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREDITS_TIMEOUT_MS);
  try {
    const res = await fetch(`${CREDITS_API_URL}/v1/credits/debit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ amount_uc }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const balance_uc = typeof body?.balance_uc === "number" ? body.balance_uc : 0;
    const earned_uc = typeof body?.earned_uc === "number" ? body.earned_uc : 0;
    // Update cache with debit result
    _creditBalanceCache = { balance_uc, earned_uc, fetched_at: Date.now() };
    return { balance_uc, earned_uc };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Invalidate the credit balance cache (e.g. after external top-up). */
export function invalidateCreditCache(): void {
  _creditBalanceCache = null;
}

/** Format micro-cents as a dollar string: 100000 uc = $1.00 */
export function formatCreditsUsd(uc: number): string {
  return `$${(uc / 100_000).toFixed(2)}`;
}

/**
 * Try to pay for an execution using credits.
 * Returns a PaymentGateResult with status "paid" and method "credits" on success,
 * or null if credits are unavailable or insufficient.
 */
export async function tryPayWithCredits(
  priceUsd: string,
  skillId: string,
  endpointId: string,
): Promise<PaymentGateResult | null> {
  const balance = await fetchCreditBalance().catch(() => null);
  if (!balance || balance.balance_uc <= 0) return null;

  // Convert price USD to micro-cents: $0.001 = 1000 uc ($1 = 1,000,000 uc)
  const priceUc = Math.ceil(parseFloat(priceUsd) * 1_000_000);
  if (priceUc <= 0) return null;

  if (balance.balance_uc < priceUc) {
    console.log(`[credits] insufficient: have ${balance.balance_uc} uc, need ${priceUc} uc — falling back to wallet`);
    return null;
  }

  // Debit credits AND record the sponsor obligation on the backend.
  // The backend tracks who is owed what. Lewis batch-settles direct USDC
  // transfers from his wallet to route creators. No Cascade, no splits —
  // just direct payments.
  const result = await debitCredits(priceUc).catch(() => null);
  if (!result) return null;

  // Record the sponsor payment obligation (fire-and-forget)
  recordSponsorObligation(priceUsd, priceUc, skillId, endpointId).catch(() => {});

  const remaining = formatCreditsUsd(result.balance_uc);
  const earned = formatCreditsUsd(result.earned_uc);

  console.log(`[credits] paid ${priceUsd} (sponsor-backed) for ${skillId}/${endpointId} — ${remaining} remaining (${earned} earned)`);

  return {
    status: "paid",
    method: "credits",
    balance_remaining_uc: result.balance_uc,
    message: `Paid with credits. ${remaining} remaining (${earned} earned from indexing).`,
  };
}

/**
 * Record a sponsor payment obligation on the backend.
 * The backend accumulates these and Lewis batch-settles direct USDC
 * transfers to route creators from his personal wallet.
 */
async function recordSponsorObligation(
  priceUsd: string,
  priceUc: number,
  skillId: string,
  endpointId: string,
): Promise<void> {
  const apiKey = getApiKey();
  if (!apiKey) return;
  const backendUrl = process.env.UNBROWSE_BACKEND_URL ?? DEFAULT_BACKEND_URL;
  await fetch(`${backendUrl}/v1/credits/sponsor-obligation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_usd: priceUsd,
      price_uc: priceUc,
      skill_id: skillId,
      endpoint_id: endpointId,
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => { /* best-effort */ });
}

// ---------------------------------------------------------------------------
// Dynamic pricing — fetch real route price from the backend
// ---------------------------------------------------------------------------

/** Backend API base URL for pricing queries. */
const PRICING_API_URL = process.env.UNBROWSE_BACKEND_URL ?? DEFAULT_BACKEND_URL;

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
    return { status: "free", method: "free", message: "No payment required." };
  }

  // --- Credit balance check (subsidized onboarding) ---
  // Try credits BEFORE requiring x402 wallet payment.
  // New agents get free credits; they only pay once credits run out.
  // Gated by UNBROWSE_CREDITS_ENABLED env var.
  if (process.env.UNBROWSE_CREDITS_ENABLED !== "0") {
    const creditResult = await tryPayWithCredits(amount, skillId, endpointId).catch(() => null);
    if (creditResult) {
      return creditResult;
    }
  }

  // --- Fall through to x402 wallet payment ---
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
        message: `Insufficient balance. Fund your wallet with at least ${requirement.amount} ${requirement.currency}.`,
        next_step: "Fund your agent wallet and retry. Routes you discover are still cached locally.",
      };

    case "wallet_not_configured":
    case "no_wallet":
      return {
        status: "wallet_not_configured",
        requirement,
        message: "No agent wallet configured. Routes you discover are cached locally — set up a wallet to earn from reuse.",
        next_step: "Set up lobster.cash to earn when other agents use routes you discovered.",
      };

    default:
      return {
        status: "payment_failed",
        requirement,
        message: `Payment failed: ${walletStatus}. You may retry.`,
        next_step: "Retry the payment. Routes you discover are still cached locally.",
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
    message: "No wallet — routes you discover are cached locally. Set up a wallet to earn when other agents reuse them.",
    next_step: "Set up lobster.cash to start earning from routes you discover through normal usage.",
  };
}
