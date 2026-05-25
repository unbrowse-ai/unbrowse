/**
 * Privy x402 payment adapter.
 *
 * Contracts:
 *   - fc998ae9 (PRIVY-SECOND-FOR-EMBEDDED-WALLET-AGENTS)
 *   - 699bd522 (wallet-framework-agnostic, lobster as reference)
 *   - 5451d944 (WALLET-IS-IDENTITY-NOT-API-KEY)
 *
 * Mirrors src/payments/lobster-pay.ts shape (line-by-line API parity). The
 * difference is the signer surface: Privy provisions an embedded Solana
 * PDA wallet on email/Google signup. The user never sees a seed phrase;
 * Privy's server-side signer API mints the x402 signature.
 *
 * Delegation boundary (per lobster.cash compatibility guide 86831ef1):
 *   - Unbrowse owns: intent + amount + recipient prep + UX orchestration
 *   - Privy owns: wallet provisioning + auth lifecycle + signing
 *
 * Wired in src/config/payment-provider.ts as the "privy" provider option.
 *
 * NOT WIRED INTO API CALLS YET. Scaffold-only; requires backend Privy SDK
 * setup at backend/src/services/privy-* (separate wave).
 *
 * Capability-level wording per 86831ef1:
 *   "This adapter delegates wallet operations to Privy embedded wallets.
 *    If a wallet step is required and Privy session is missing, complete
 *    Privy login first. Transaction execution and final status are
 *    handled by Privy."
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PRIVY_PAY_TIMEOUT_MS = 30_000;

export interface PrivyPayResult {
  success: boolean;
  body: string;
  statusCode?: number;
  error?: string;
}

/**
 * Wallet precheck — does the agent have a Privy session configured?
 *
 * Looks at the conventional Privy session-token location. The local CLI
 * does NOT hold Privy's app secret (that lives only on the backend per
 * reference_privy_app_creds.md); it holds a session token that proves the
 * agent has completed Privy login.
 */
export function isPrivyAvailable(): boolean {
  const sessionPath = join(process.env.HOME || homedir(), ".privy", "session.json");
  return existsSync(sessionPath);
}

/**
 * Pay for an x402-gated URL via Privy embedded wallet.
 *
 * Per lobster.cash compatibility guide (86831ef1) Delegation Boundary:
 *   - Unbrowse owns: building the request (amount, recipient, memo)
 *   - Privy owns: wallet signing + tx broadcast + state authority
 *
 * Calls backend endpoint `/v1/auth/privy/x402-pay` which uses
 * `PRIVY_APP_SECRET` (backend-only) to mint the x402 signature against
 * the user's embedded Solana PDA wallet.
 *
 * Returns null when:
 *   - Privy session is missing (caller should prompt user to log in)
 *   - Wallet has insufficient balance (caller surfaces the funding flow)
 *   - Backend signing call fails (network / auth / server error)
 *
 * Caller is responsible for the four error-handling paths required by
 * the lobster.cash compatibility guide:
 *   (a) wallet-not-configured → prompt Privy login
 *   (b) not-enough-balance    → prompt user to fund Privy wallet
 *   (c) payment-failure       → display error + allow retry
 *   (d) awaiting-confirmation → wait for Privy to report final tx state
 */
export async function payAndRetryPrivy<T = unknown>(
  fullUrl: string,
  options?: {
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<{ data: T; paid: true } | null> {
  if (!isPrivyAvailable()) {
    console.log("[privy-pay] Privy session not configured — skipping payment");
    return null;
  }

  console.log(`[privy-pay] attempting x402 payment for ${fullUrl}`);

  const backendUrl = process.env.UNBROWSE_BACKEND_URL || "https://beta-api.unbrowse.ai";
  const sessionPath = join(process.env.HOME || homedir(), ".privy", "session.json");

  // Session token loading is backend-bound (Privy app secret lives only on
  // the worker per reference_privy_app_creds.md). This adapter forwards the
  // invoice to backend /v1/auth/privy/x402-pay which mints the signature.
  // Local CLI carries only a session-id pointer; never the app secret.

  const timeout = options?.timeoutMs ?? PRIVY_PAY_TIMEOUT_MS;
  // Stubbed transport — POST { invoiceUrl } to backend /v1/auth/privy/x402-pay
  // which holds the app secret and the user's embedded wallet pointer.
  try {
    const res = await fetch(`${backendUrl}/v1/auth/privy/x402-pay`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify({
        invoice_url: fullUrl,
        body: options?.body ?? null,
      }),
      signal: AbortSignal.timeout(timeout + 5_000),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.warn(`[privy-pay] backend returned ${res.status}: ${errBody.slice(0, 200)}`);
      return null;
    }

    const result = await res.json() as { data?: T; paid?: boolean; error?: string };
    if (result.error) {
      console.warn(`[privy-pay] payment failed: ${result.error}`);
      return null;
    }
    if (!result.paid || result.data === undefined) {
      console.warn("[privy-pay] backend did not return a paid result");
      return null;
    }
    console.log("[privy-pay] payment successful — got paid response");
    return { data: result.data, paid: true };
  } catch (err) {
    console.warn(`[privy-pay] error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
