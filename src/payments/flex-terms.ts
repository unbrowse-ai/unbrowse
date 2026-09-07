// src/payments/flex-terms.ts
// The CLIENT-SIDE view of the Flex 402 wire contract — the stable HTTP API seam.
//
// These types describe the JSON the backend serializes into a 402 response
// (`accepts[0]` for the `@faremeter/flex` scheme). The open client declares its
// OWN view of that wire shape so it never imports backend source: the backend can
// live in a separate repo and the only coupling is this published contract over
// HTTP. The client reads these terms verbatim (splits + escrow are frozen,
// backend-computed) and never recomputes them.

/** Off-chain semantic label for a split recipient (audit only; never on-chain). */
export type FlexSplitRole =
  | "infrastructure" | "site_owner" | "contributor" | "maintainer" | "treasury";

/** One payout leg of a settled toll. bps across all splits sum to 10000. */
export interface FlexSplit {
  recipient: string; // SPL token account (USDC ATA) of the recipient
  bps: number;       // basis points
  role?: FlexSplitRole;
}

/** The escrow authorization draft the client signs + submits (read verbatim). */
export interface FlexAuthorizationDraft {
  escrow: string;
  authorizationId: string;
  expiresAtSlot: string | number | bigint;
  // tolerate additional wire fields (mint, programId echoes, etc.) without coupling
  [k: string]: unknown;
}

/** The `@faremeter/flex` accept entry inside a 402's `accepts` array. */
export interface FlexAcceptEntry {
  scheme: "@faremeter/flex";
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    flexAuthorizationDraft: FlexAuthorizationDraft;
    splits: FlexSplit[];
    programId: string;
  };
}

/** The full 402 envelope. `accepts` may carry other schemes (e.g. exact). */
export interface FlexPaymentRequired {
  x402Version?: number;
  error?: string;
  resource?: { url: string; description: string; mimeType: string };
  accepts: Array<FlexAcceptEntry | { scheme: string; [k: string]: unknown }>;
}
