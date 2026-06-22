/**
 * contract-pay — the opt-in x402 COMPENSATION tier over a /contract agent's RBAC.
 *
 * The ask: each /contract-based agent's RBAC can OPTIONALLY make a GET or POST task PAYABLE via x402,
 * so an agent is compensated to have something done.
 *
 * Two layers, kept separate (single responsibility):
 *   1. RBAC (grantGate / any opt-in policy) decides WHO may reach a task — the `allowed` boolean.
 *   2. payGate (here) adds the OPTIONAL compensation tier: a grant may attach a PRICE to a method
 *      (GET = a read, POST = an act — the same read/act split as contract-browse). When the task is
 *      allowed AND a price is set for its method, payGate returns a 402 x402 quote payable to the
 *      AGENT's wallet. No price → free. Not allowed → denied.
 *
 * Load-bearing rule (Decalogue cmd 8 — thou shalt not steal): payment can NEVER buy past RBAC. You
 * pay only for a task you were already permitted to reach; a denied caller stays denied even with a
 * price. The 402 is a quote for permitted-but-priced work, not a bribe past the gate.
 *
 * The settlement itself is the existing x402 machinery (src/payments/x402-fetch.ts); payGate decides
 * WHEN payment is required and emits the canonical x402 quote (the 402 envelope shape).
 */
import { contractVerdictFromEnvelope, type ContractVerdict } from "./contract-shape";

export type HttpMethod = "GET" | "POST";

/** Canonical USDC mint on Solana — the default settlement asset (FDRY bonds, USDC settles). */
const USDC_SOL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** An opt-in price a grant attaches per task method. A method absent here is FREE. Amounts are in
 *  the asset's atomic units (USDC = 6 decimals, so "10000" = $0.01). */
export interface PricePolicy {
  GET?: { amount: string; asset?: string };
  POST?: { amount: string; asset?: string };
}

/** The canonical x402 quote — "pay this to have this done". `payTo` is the agent being compensated. */
export interface X402Quote {
  scheme: "exact";
  amount: string;
  asset: string;
  payTo: string;
  resource: string;
  network: string;
}

export type PayDecision =
  | { kind: "denied"; surface: string; _contract: ContractVerdict }
  | { kind: "free"; surface: string; method: HttpMethod; _contract: ContractVerdict }
  | { kind: "payment_required"; surface: string; method: HttpMethod; quote: X402Quote; _contract: ContractVerdict };

/**
 * payGate — given an RBAC decision + an optional per-method price, decide free / payment_required /
 * denied. The x402 quote is payable to the agent's wallet (who gets compensated).
 */
export function payGate(opts: {
  surface: string;
  method: HttpMethod;
  /** the RBAC verdict — grantGate.visible, or any opt-in policy. */
  allowed: boolean;
  /** the grant's OPTIONAL per-method price (opt-in; absent → the task is free). */
  price?: PricePolicy;
  /** the AGENT's wallet — who is compensated for doing the work. */
  recipient: string;
  /** the task pointer being paid for. */
  resource: string;
  network?: string;
}): PayDecision {
  const { surface, method, allowed } = opts;
  if (!allowed) {
    // payment NEVER buys past RBAC (Decalogue cmd 8) — a denied caller stays denied
    return { kind: "denied", surface, _contract: contractVerdictFromEnvelope({ ok: false, surface, reason: "rbac-denied" }) };
  }
  const tier = opts.price?.[method];
  if (!tier) {
    return { kind: "free", surface, method, _contract: contractVerdictFromEnvelope({ ok: true, surface, method, payable: false }) };
  }
  // Fail-closed on a money path: a malformed amount ("0", "-5", "abc", "") or a missing recipient
  // would emit a quote that pays nobody or settles to junk — never emit a bogus quote (Decalogue
  // cmd 9, no false witness on a payment). A valid amount is a positive integer in atomic units.
  if (!/^[1-9][0-9]*$/.test(tier.amount) || !opts.recipient) {
    return { kind: "denied", surface, _contract: contractVerdictFromEnvelope({ ok: false, surface, reason: "invalid-price" }) };
  }
  const quote: X402Quote = {
    scheme: "exact",
    amount: tier.amount,
    asset: tier.asset ?? USDC_SOL_MINT,
    payTo: opts.recipient,
    resource: opts.resource,
    network: opts.network ?? "solana",
  };
  return {
    kind: "payment_required",
    surface,
    method,
    quote,
    _contract: contractVerdictFromEnvelope({ ok: true, surface, method, payable: true, amount: tier.amount }),
  };
}
