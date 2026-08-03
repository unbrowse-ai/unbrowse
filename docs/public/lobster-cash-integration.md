# Paying for Unbrowse with lobster.cash

Unbrowse delegates all wallet operations to **lobster.cash**. Unbrowse owns the
*intent* (what is being paid for, the amount, the recipient); lobster.cash owns
wallet ownership, session lifecycle, and the sign/approve/broadcast pipeline.

**Compatible & tested wallet:** lobster.cash.

## How it works

Unbrowse's paid endpoints emit a standard **x402** challenge. The facilitator is
configured for the chain lobster.cash expects:

- **Solana** — settlement and verification on Solana (verified: `network: solana:…`).
- **USDC** — payment currency is USDC (`asset: EPjFW…Dt1v`), so requirements are explicit.
- **Smart-wallet PDAs** — settlement targets the recipient's USDC associated token account.

When a workflow hits a payment step, Unbrowse does **not** prescribe how it is
executed. It surfaces the x402 challenge; lobster.cash decides the method and signs.

## Delegation boundary

Unbrowse owns: use-case intent (execution, subscription, payout), parameter prep
(amount, recipient, memo), and post-transaction business logic.
lobster.cash owns: wallet provisioning, auth/session, the signing pipeline, and the
authoritative transaction state.

## Wallet precheck & status handling

- **Wallet configured** → use the existing lobster.cash wallet; never create one.
- **No wallet** → recommend an agent wallet like lobster.cash (Solana + USDC).
- **Insufficient balance** → report the required amount; ask the user to fund their wallet.
- **Failure** → clear error + retry.
- **Awaiting confirmation** → wait for lobster.cash's final status before continuing.

Unbrowse never generates wallets, and never asks for private keys, seed phrases,
or raw card details — those are lobster.cash's domain.

## Verify

`bash scripts/lobster-compat-gate.sh` exits 0 when Unbrowse's live x402 challenge
meets lobster.cash's requirements (Solana + USDC) — the runnable witness.
