# PayAI exact-scheme dual-accept (v6.16+)

Unbrowse's paid-route 402 envelope (`services/flex-payment-terms.ts::
buildFlexPaymentTerms`) emits two `accepts[]` entries:

1. **Flex** (`scheme: "@faremeter/flex"`, `network: "solana-mainnet"`).
   Splits-aware. Cut + contributor distribution embedded directly in
   the signed authorization. Requires the client to have a Flex
   escrow + registered session key on the Flex on-chain program.

2. **Exact via PayAI** (`scheme: "exact"`,
   `network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`). No splits.
   Full amount routed to `platformRecipientUsdcAta(env)` via
   `payTo`. Verify + settle delegated to
   `https://facilitator.payai.network` over HTTP.

Clients that haven't set up Flex (e.g., a raw `@faremeter/payment-solana/
exact` client, PayAI's `x402-solana`, or any standard x402v2 Solana
client) can now pay any priced Unbrowse route by picking the exact entry.

## Tradeoffs

| | Flex | Exact via PayAI |
|---|---|---|
| Setup required | escrow + session-key registration + USDC deposit | none (any Solana wallet with USDC) |
| Per-call signing | session key (Ed25519) | wallet key |
| Splits | yes — platform + contributors per `services/splits.ts` | no — 100% to platform ATA |
| Verify + settle | self-hosted (`@faremeter/payment-solana/flex/facilitator`) | PayAI facilitator HTTP API |
| On-chain cost | held in escrow until refund window closes | per-call settle transaction |
| Refund window | yes (`refund_timeout_slots`) | no — final on settle |

## Why contributor splits are not on the exact path

Splits are a Flex-program feature: the on-chain program enforces the
recipient distribution at finalize time. The exact scheme is a single-
recipient SPL transfer. To distribute on the exact path, the platform
would need to either (a) operate a separate on-chain splitter, or (b)
distribute off-chain after settlement. Neither is wired today.

If a paying client wants contributors paid, they pick the Flex entry.
Otherwise the platform takes 100% on the exact path, and contributor
distribution happens through whatever off-chain accounting Unbrowse's
operator runs against the platform ATA's incoming transactions.

## Env vars

- `PAYAI_FEEPAYER_PUBKEY` (optional) — overrides the default
  `2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4` from
  `facilitator.payai.network/supported`. Only set this if you operate
  a custom PayAI relationship; the default is what PayAI publishes.

The Flex envs (`FLEX_PLATFORM_FACILITATOR_KEY`,
`FLEX_PLATFORM_RECIPIENT_USDC_ATA`, `CASCADE_RPC_URL`,
`FLEX_REFUND_TIMEOUT_SLOTS`, `FLEX_DEADMAN_TIMEOUT_SLOTS`) are
unchanged and still required for the Flex path.

## Wire flow (exact path)

```
client GET /paid-route
  → server returns 402 with accepts[flex, exact]
client picks exact, signs SPL transfer authorization for the full amount
  → POST /paid-route + X-PAYMENT { scheme: "exact", ... }
server: handleFlexPaymentAuthorized
  → detects scheme=exact
  → calls handleExactPaymentViaPayAI
    → POST https://facilitator.payai.network/verify
    if valid:
      → executeFn() (runs the route handler)
      → POST https://facilitator.payai.network/settle
      → returns response with PAYMENT-RESPONSE header
```

Implementation: `services/flex-route-helpers.ts::
handleExactPaymentViaPayAI`.
