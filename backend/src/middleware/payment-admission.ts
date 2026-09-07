/**
 * UNIFIED x402 payment-admission boundary.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ADMISSION ONLY — settlement/debit happens downstream in the gated execute
 * path; this NEVER moves funds. `admitPayment` is PURE DETECTION: it identifies
 * the payer + the lane and returns the verdict. It does not sign, send, or
 * broadcast any transaction, does not debit any wallet, and does not decrement
 * any credit budget. Those side effects stay where they already are:
 *   - wallet-signed x402 → `handleFlexPaymentAuthorized` (skills.ts, gated).
 *   - api-key→credit     → `debitKeyFunding` (KV decrement, gated).
 *   - api-key→wallet     → the Flex facilitator path at PAYOUT time
 *                          (`services/splits.ts::resolveContributorWallets`).
 *   - sponsor            → `maybeSponsor` (middleware/sponsor.ts, gated).
 *
 * Today the admission decision is SPLIT across disjoint branches in
 * `src/routes/skills.ts`. This boundary unifies the *recognition* of who the
 * payer is, in the SAME priority order the existing route uses:
 *
 *   wallet-signed (X-PAYMENT) → api-key→getKeyFunding{kind:"wallet"} →
 *   {kind:"credit"} → sponsor → none.
 *
 * The `kind:"wallet"` lane is what makes "the api_key wraps a wallet"
 * RESOLVABLE at admission: a key-bound wallet IS the payer-of-record, and it is
 * settled by the existing Flex path (gated), not here. Before this boundary the
 * bound wallet was only ever consulted at PAYOUT time, never as a payer at
 * admission.
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { Context } from "hono";
import type { Env } from "../types.js";
import type { KeyFunding } from "../services/keys.js";

export type PaymentLane = "wallet" | "api-key" | "credit" | "delegated" | "sponsor" | "none";

export interface PaymentAdmission {
  /** True iff a payer/lane was identified that the gated path can settle. */
  admitted: boolean;
  /** The payer-of-record wallet when one is resolvable, else null. */
  payerWallet: string | null;
  /** Which admission lane recognised the payer. */
  lane: PaymentLane;
  /**
   * On the `delegated` lane only: the on-chain facts the gated execute path
   * needs to settle against the USER's escrow (never recomputed here — pure
   * detection). Absent on every other lane.
   */
  delegation?: {
    escrow: string;              // user's escrow PDA — the funds source
    session_key_address: string; // the delegated session key registered to it
    cap_uc: number;              // total delegated cap (rolling ledger ceiling)
    expires_at_slot: string;     // on-chain session-key expiry slot
  };
}

// Context here is intentionally permissive: admitPayment is called from routes
// whose Variables shapes differ. We only read c.req.header / c.env / c.get,
// which exist on every Context<{Bindings: Env}>.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdmissionContext = Context<{ Bindings: Env; Variables: any }>;

/**
 * Resolve the api-key → funding binding for this request.
 *
 * Test seam: when `env.__TEST_KEY_FUNDING__` is defined the test has seeded the
 * binding directly, so we use it (hermetic — no KV / network). Otherwise we go
 * through the real `getKeyFunding(env, keyId)`. This reads the binding only; it
 * never debits it.
 */
async function resolveKeyFunding(
  c: AdmissionContext,
  agentId: string | undefined,
): Promise<KeyFunding | null> {
  const seeded = (c.env as unknown as Record<string, unknown>).__TEST_KEY_FUNDING__;
  if (seeded !== undefined) {
    return (seeded as KeyFunding | null) ?? null;
  }
  if (!agentId || agentId === "__admin__") return null;
  const { getKeyFunding } = await import("../services/keys.js");
  return getKeyFunding(c.env, agentId);
}

/**
 * Best-effort: pull the signer wallet out of an X-PAYMENT proof header.
 *
 * ADMISSION-ONLY, and deliberately conservative: we do NOT verify the signature
 * here (that is the gated Flex settlement path's job). But we MUST NOT promote
 * arbitrary attacker-controlled header bytes to a payer-of-record wallet. So we
 * only return a wallet when the header is a JSON object that carries BOTH a
 * non-empty `payer`/`from` string AND proof material (`signature`/`payload`/
 * `proof`). A bare `{"payer":"x"}` with no proof field, non-JSON garbage, or a
 * blank/whitespace wallet string all yield null → the caller falls through to
 * the next lane and never trusts the unsigned bytes as a wallet.
 */
function payerFromPaymentHeader(header: string | undefined): string | null {
  if (!header) return null;
  let proof: { payer?: unknown; from?: unknown; signature?: unknown; payload?: unknown; proof?: unknown };
  try {
    const parsed = JSON.parse(header);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    proof = parsed as typeof proof;
  } catch {
    return null;
  }
  // Require proof material to be present before treating this as a real x402
  // proof. Without it, the header is just an unsigned claim of a wallet address.
  const hasProofMaterial =
    (typeof proof.signature === "string" && proof.signature.length > 0) ||
    (typeof proof.payload === "string" && proof.payload.length > 0) ||
    (typeof proof.proof === "string" && proof.proof.length > 0);
  if (!hasProofMaterial) return null;
  const payer = proof.payer ?? proof.from;
  if (typeof payer !== "string") return null;
  const trimmed = payer.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A wallet string is a usable payer-of-record only if it is non-empty after trimming. */
function validWallet(wallet: unknown): string | null {
  if (typeof wallet !== "string") return null;
  const trimmed = wallet.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Identify the payer + lane for this request. PURE ADMISSION — no funds move.
 *
 * Priority mirrors `routes/skills.ts`:
 *   1. wallet-signed x402  — X-PAYMENT header carries a signer; that signer is
 *                            the payer-of-record (settled by the gated Flex path).
 *   2. api-key → wallet    — the bearer key wraps a wallet binding; the bound
 *                            wallet is the payer (settled by the gated Flex path).
 *   3. api-key → credit    — the key wraps a prepaid credit budget; payer is the
 *                            account, no wallet of record (settled by the gated
 *                            KV decrement). payerWallet is null.
 *   4. sponsor             — a resolved agent may have the platform cover the
 *                            call (settled by the gated sponsor path).
 *   5. none                — neither a proof nor a recognised key.
 */
export async function admitPayment(c: AdmissionContext): Promise<PaymentAdmission> {
  // 1. Wallet-signed x402 proof.
  const paymentHeader = c.req.header("X-PAYMENT");
  const signer = payerFromPaymentHeader(paymentHeader);
  if (signer) {
    return { admitted: true, payerWallet: signer, lane: "wallet" };
  }

  // 2 + 3. API-key lane: does a bearer key resolve to a funding binding?
  const authz = c.req.header("Authorization");
  const hasBearer = typeof authz === "string" && authz.startsWith("Bearer ");
  if (hasBearer) {
    const agentId = c.get("agent_id") as string | undefined;
    const funding = await resolveKeyFunding(c, agentId);
    if (funding?.kind === "wallet") {
      // The key wraps a wallet → the bound wallet is the payer-of-record, but
      // only if it is a real (non-blank) wallet string. A blank/whitespace
      // binding is corrupt and must NOT be admitted as a valid payer; fall
      // through rather than surface an empty payerWallet as admitted:true.
      const bound = validWallet(funding.wallet);
      if (bound) {
        return { admitted: true, payerWallet: bound, lane: "api-key" };
      }
    }
    if (funding?.kind === "delegated") {
      // The key wraps a NON-CUSTODIAL delegation → the user's wallet is the
      // payer-of-record (like the wallet lane), but settlement is the
      // escrow-signing path (gated, downstream), NOT a prepaid KV debit. Pure
      // detection: surface the escrow/cap/expiry so the gated execute path can
      // sign a Flex authorization against the USER's escrow within the cap. We
      // never sign here. A blank/whitespace wallet or escrow is a corrupt
      // binding and must NOT be admitted — fall through rather than surface it.
      const bound = validWallet(funding.wallet);
      const escrow = validWallet(funding.escrow);
      if (bound && escrow) {
        return {
          admitted: true,
          payerWallet: bound,
          lane: "delegated",
          delegation: {
            escrow,
            session_key_address: funding.session_key_address,
            cap_uc: funding.cap_uc,
            expires_at_slot: funding.expires_at_slot,
          },
        };
      }
    }
    if (funding?.kind === "credit") {
      // The key wraps a prepaid credit budget → account pays, no wallet.
      return { admitted: true, payerWallet: null, lane: "credit" };
    }
  }

  // 4. Sponsor lane: a resolved agent (no proof, no key funding) may be
  // sponsored. We only RECOGNISE the lane here; the actual sponsor decision +
  // settlement stays in middleware/sponsor.ts (gated). Recognition requires a
  // resolved agent and the absence of an explicit opt-out.
  const agentId = c.get("agent_id") as string | undefined;
  const optedOutOfSponsor = c.req.header("X-No-Sponsor") === "1";
  if (agentId && agentId !== "__admin__" && !optedOutOfSponsor) {
    return { admitted: true, payerWallet: null, lane: "sponsor" };
  }

  // 5. Nothing recognised.
  return { admitted: false, payerWallet: null, lane: "none" };
}
