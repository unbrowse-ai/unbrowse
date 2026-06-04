/**
 * Typed client for the public /v1/claim/* surface.
 *
 * Three flows, no auth required at the page level (the backend enforces
 * caller wallet equality on verify):
 *   1. Domain wallet claim: POST /challenge, then POST /verify, then GET /status.
 *   2. Domain marketplace opt-out: POST /takedown/challenge, then POST /takedown/verify,
 *      then GET /takedown/status.
 *   3. Official-API submission: POST /submit-official.
 *
 * Mirrors the pattern in `frontend/src/lib/account-client.ts` but without
 * the bearer-auth wrapper, since /claim/* is largely public (challenge mint
 * and status are public; verify checks the caller wallet server-side).
 */

import { getConfiguredApiOrigin } from "./api-base";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChallengeEnvelope {
  domain: string;
  wallet_address?: string;
  challenge: string;
  txt_name: string;
  txt_value: string;
  expires_at: string;
}

export interface VerifyOk {
  ok: true;
  verified_at: string;
  domain: string;
  wallet_address?: string;
}

export interface VerifyError {
  ok?: false;
  error: string;
  message?: string;
}

export type VerifyResult = VerifyOk | VerifyError;

export interface ClaimStatus {
  verified: boolean;
  wallet_address?: string;
  verified_at?: string;
  message?: string;
}

export interface TakedownVerifyOk {
  ok: true;
  disabled_count: number;
  opted_out_at: string;
  domain: string;
}

export type TakedownVerifyResult = TakedownVerifyOk | VerifyError;

export interface TakedownStatus {
  opted_out: boolean;
  opted_out_at?: string;
  disabled_count?: number;
  message?: string;
}

/**
 * Real read over on-chain settlement for a bound domain owner. Mirrors the
 * public GET /v1/claim/earnings response. Amounts are a mirror of what already
 * settled to the wallet on-chain — never a projection.
 * Unverified (unbound) domains come back with `verified: false` and zeroes.
 */
export interface EarningsResult {
  verified: boolean;
  domain?: string;
  wallet_address?: string;
  earned_uc: number;
  earned_usd: string;
  pending_uc?: number;
  pending_usd?: string;
  payout_count?: number;
  last_tx?: string | null;
  last_settled_at?: string | null;
}

export interface OfficialEndpointInput {
  method: string;
  url_template: string;
  description: string;
  x402_supported: boolean;
}

export interface SubmitOfficialBody {
  domain: string;
  contact_email: string;
  name?: string;
  description?: string;
  endpoints: OfficialEndpointInput[];
}

export interface SubmitOfficialResponse {
  submission_id: string;
  status: "received" | "queued" | "verified" | string;
  message?: string;
}

export class ClaimClientError extends Error {
  status: number;
  payload?: unknown;
  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name = "ClaimClientError";
    this.status = status;
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// Internal request helper
// ---------------------------------------------------------------------------

async function readErrorBody(res: Response): Promise<{ message: string; payload: unknown }> {
  try {
    const text = await res.text();
    if (!text) return { message: res.statusText, payload: undefined };
    try {
      const j = JSON.parse(text) as { message?: string; error?: string };
      return { message: j.message ?? j.error ?? text, payload: j };
    } catch {
      return { message: text, payload: text };
    }
  } catch {
    return { message: res.statusText, payload: undefined };
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const origin = getConfiguredApiOrigin();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Verify endpoints can return a structured error envelope even on
    // 409 dns_mismatch / 501 not_implemented; preserve the JSON payload.
    const { message, payload } = await readErrorBody(res);
    throw new ClaimClientError(res.status, message, payload);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Wallet-claim flow
// ---------------------------------------------------------------------------

export async function postChallenge(input: {
  domain: string;
  wallet: string;
}): Promise<ChallengeEnvelope> {
  return request<ChallengeEnvelope>("POST", "/v1/claim/challenge", {
    domain: input.domain,
    wallet_address: input.wallet,
  });
}

export async function postVerify(input: {
  domain: string;
  wallet: string;
}): Promise<VerifyResult> {
  try {
    return await request<VerifyOk>("POST", "/v1/claim/verify", {
      domain: input.domain,
      wallet_address: input.wallet,
    });
  } catch (err) {
    if (err instanceof ClaimClientError) {
      const payload = err.payload as VerifyError | undefined;
      return {
        ok: false,
        error: payload?.error ?? "request_failed",
        message: payload?.message ?? err.message,
      };
    }
    throw err;
  }
}

export async function getStatus(domain: string): Promise<ClaimStatus> {
  return request<ClaimStatus>(
    "GET",
    `/v1/claim/status?domain=${encodeURIComponent(domain)}`,
  );
}

/**
 * Read what a bound domain's wallet has actually been paid on-chain. This is a
 * read, not a withdrawal: the owner lane settles directly to the wallet's USDC
 * account at settlement time, so the numbers returned mirror on-chain state.
 */
export async function getEarnings(domain: string): Promise<EarningsResult> {
  return request<EarningsResult>(
    "GET",
    `/v1/claim/earnings?domain=${encodeURIComponent(domain)}`,
  );
}

// ---------------------------------------------------------------------------
// Takedown flow
// ---------------------------------------------------------------------------

export async function postTakedownChallenge(input: {
  domain: string;
}): Promise<ChallengeEnvelope> {
  return request<ChallengeEnvelope>("POST", "/v1/claim/takedown/challenge", {
    domain: input.domain,
  });
}

export async function postTakedownVerify(input: {
  domain: string;
}): Promise<TakedownVerifyResult> {
  try {
    return await request<TakedownVerifyOk>("POST", "/v1/claim/takedown/verify", {
      domain: input.domain,
    });
  } catch (err) {
    if (err instanceof ClaimClientError) {
      const payload = err.payload as VerifyError | undefined;
      return {
        ok: false,
        error: payload?.error ?? "request_failed",
        message: payload?.message ?? err.message,
      };
    }
    throw err;
  }
}

export async function getTakedownStatus(domain: string): Promise<TakedownStatus> {
  return request<TakedownStatus>(
    "GET",
    `/v1/claim/takedown/status?domain=${encodeURIComponent(domain)}`,
  );
}

// ---------------------------------------------------------------------------
// Official-API submission flow
// ---------------------------------------------------------------------------

export async function postSubmitOfficial(
  body: SubmitOfficialBody,
): Promise<SubmitOfficialResponse> {
  return request<SubmitOfficialResponse>(
    "POST",
    "/v1/claim/submit-official",
    body,
  );
}

/**
 * Build a mailto: fallback URL for users who'd rather email the team
 * directly. Keeps the same shape as the form so we can promote either
 * channel without code drift.
 */
export function buildOfficialSubmissionMailto(domain: string): string {
  const subject = `Official skill submission for ${domain || "<domain>"}`;
  const lines = [
    `Domain: ${domain || "<your-domain>"}`,
    "Contact email:",
    "Name (optional):",
    "Description (optional):",
    "",
    "Endpoints:",
    "  - method: GET",
    "    url_template: https://api.example.com/v1/...",
    "    description: what it returns",
    "    x402_supported: true|false",
  ];
  const body = lines.join("\n");
  return `mailto:hello@unbrowse.ai?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
