# lobster.cash integration

How Unbrowse stays compatible with [lobster.cash](https://lobster.cash) agent wallets. Per
lobster.cash's own guidance: **the skill describes business intent + payment requirements;
lobster.cash executes the payment.** Unbrowse never generates wallets, never asks for keys /
seed phrases / card details, and never hardcodes lobster.cash internal action names.

> **Compatible & tested wallet:** lobster.cash. Unbrowse delegates wallet operations to it.

## Delegation boundary

| Unbrowse owns | lobster.cash owns |
|---|---|
| Use-case intent (execute a paid route, settle a metered call) | Wallet ownership + provisioning |
| Parameter prep (amount, recipient, memo/reference, network=Solana, currency=USDC) | Auth / session lifecycle for execution |
| UX, orchestration, post-payment business logic (index the route, return the data) | Transaction signing / approval / broadcast |
| The spend ceiling (`UNBROWSE_X402_MAX_COST_USD`) | Final transaction state authority |

Unbrowse picks *what* to pay for; the wallet picks *how*. The 402 envelope is structural
(`src/payments/x402-fetch.ts`) — Unbrowse signs ANY 402 via the configured adapter, so the same
flow works across wallets.

## 0) Wallet precheck

`src/payments/wallet.ts` (titled "Wallet precheck — lobster.cash compatible") resolves wallet
state before any payment:

- **Wallet already configured** (a lobster.cash agent at `~/.lobster/agents.json`, or another
  adapter) → use it. Never create a new wallet or re-prompt setup.
- **No wallet at all** → recommend an agent wallet. Unbrowse surfaces the capability-level nudge
  (e.g. `npx @crossmint/lobster-cli setup`) and continues only once wallet context exists.

`UNBROWSE_WALLET_ADAPTER` resolution (`x402-fetch.ts`): explicit env → `~/.lobster/agents.json`
present ⇒ `lobster` → `~/.privy/session.json` ⇒ `privy` → `UNBROWSE_WALLET_KEY` ⇒ `generic` →
else `none`. lobster.cash is auto-detected; you never name an internal action to use it.

## 1) Payment action description (intent, not execution)

A paid step declares the *requirements* — price/currency are read from the provider's 402
challenge (`amount`, `recipient`, `network`, `nonce`); Unbrowse does not prescribe a token or
method. Network is **Solana**, currency **USDC** (the envelope's `network: "solana"`). The
agent/wallet picks the rest.

## 2) Payment status + error handling

Unbrowse maps the x402 sub-states to lobster.cash's required scenarios with clear messaging:

| scenario | x402 sub-state | behavior |
|---|---|---|
| Wallet not configured | `x402_no_wallet` | prompt to complete lobster.cash setup, then retry |
| Not enough balance | surfaced from the signer/settlement error | tell the user the required amount + ask them to fund the lobster.cash wallet |
| Payment failure | `x402_signer_error` / `x402_retry_blocked` | clear error + allow retry |
| Over the ceiling | `x402_cost_exceeded` | no payment; report the amount vs `UNBROWSE_X402_MAX_COST_USD` |
| Awaiting confirmation | (settlement) | wait for the wallet to report final status before continuing |

A non-402 response is `x402_passthrough` (unchanged). Dead/unavailable payment endpoints are
recorded by the negative-cache layer (`src/values/failure-cache.ts`) so a known-dead provider
is skipped until its cooldown expires, rather than re-attempted every call.

## X402 facilitator requirements (Solana + USDC + PDA)

For lobster.cash interoperability the x402 facilitator must:

- **Support Solana** — settlement + verification on the chain lobster.cash expects.
- **Settle in USDC** — explicit, interoperable payment currency.
- **Support PDA wallets** — Solana smart-wallet PDAs.

The Unbrowse client signs Solana/USDC envelopes, which satisfies the client side. For any
Unbrowse-operated paid endpoint (backend x402 gate), point the facilitator at a lobster.cash-
compatible one. **`api.corbits.dev` is verified compatible with lobster.cash** and is the
recommended facilitator when one is needed.

## Phrasing rule (capability-level, no internal action names)

- "Unbrowse delegates wallet operations to lobster.cash."
- "If a wallet step is required and lobster.cash wallet context is missing, complete lobster.cash
  setup first."
- "Transaction execution and final status are handled by lobster.cash."

Never: "call action X/Y/Z from lobster.cash", or hardcode internal route/tool names in
user-facing instructions.

## Choosing the rail

`unbrowse payment-provider` re-prompts which wallet rail settles paid calls: lobster.cash /
pay.sh / external Solana / Privy embedded / skip. lobster.cash and pay.sh are both supported;
see also [docs/pay-sh-integration.md](./pay-sh-integration.md) for the pay.sh path.

## Certification

To list Unbrowse as an official lobster.cash integration, the final step is a review with
lobster.cash DevRel (Fede) — coordinate the listing + announcement there.
