# Wallets & payments — two ways to pay (wallet signature or a bound API key)

Unbrowse priced calls (search-on-top, route execution) settle **per request via
[x402](https://www.x402.org)** in USDC on Solana. Unbrowse never holds your keys:
it prepares the payment *intent* (amount, currency, reason) and **delegates
execution to your wallet**. Transaction signing, approval, broadcast, and final
status are owned by the wallet.

## Native wallet support: the Wallet Standard

Unbrowse speaks the [Wallet Standard](https://github.com/wallet-standard/wallet-standard)
(open-wallet-standard), so **any** standard Solana wallet works — no per-wallet
integration. Discover wallets the app already exposes and turn one into a payment
handler:

```ts
import { Unbrowse } from "unbrowse/sdk";
import { walletStandardPay, pickSolanaWallets } from "unbrowse/sdk/wallet-standard";
import { getWallets } from "@wallet-standard/app"; // your app supplies this

const wallet = pickSolanaWallets(getWallets().get())[0];
const unbrowse = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY, pay: walletStandardPay(wallet) });
```

The bridge in `unbrowse/sdk/wallet-standard` is **zero-dependency** — it consumes
the Wallet Standard shape structurally, so the SDK stays light and browser-safe.

### Compatible & tested wallets

- **lobster.cash** — compatible and tested. An agent wallet for the web; it owns
  provisioning, authentication, signing, and the final transaction state. If a
  payment step is required and your wallet context is missing, complete your
  wallet setup first.
- Any Wallet Standard Solana wallet (Phantom, Solflare, Backpack, a Privy
  embedded Solana wallet, …).

The skill describes *what* to pay and *why*; the wallet decides *how*. We do not
prescribe a currency, token, or method beyond the x402 requirement, and we do not
call wallet operations by name — execution is the wallet's.

## Two ways to pay

A priced call can be satisfied in **either** of two ways — both resolve to the
same question (*who is the payer-of-record*) through one admission boundary. See
the [x402 Payment API](../api/x402.md) for the full contract.

**(a) Wallet signature** — sign the x402 authorization (Solana USDC) and present
it in the `X-PAYMENT` header on the retry. The signer is the payer-of-record.
This is the path the Wallet Standard examples above walk, and it works today.

**(b) A bound API key** — an API key is a web2 wrapper around a wallet. Bind a
key to a wallet and the key *authenticates* the request while the bound wallet is
recognized as the payer-of-record:

```ts
import { Unbrowse } from "unbrowse/sdk";

const unbrowse = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });
```

> Status: two ways an API key pays from a wallet, both real:
> - **Prepaid (shipped).** Bind the key to a wallet, deposit USDC once
>   (`POST /v1/account/keys/:id/deposit` — a single signature), and the key then
>   pays per call from that prepaid balance with **no per-call signature**. The
>   platform custodies the *deposited balance* (not the wallet key); the unspent
>   remainder is an IOU.
> - **Non-custodial delegated (built, activating).** The wallet keeps its funds in
>   its *own* on-chain escrow and grants a **cap-bounded, expiring, revocable**
>   session key; the key draws per call within the cap, the funds never leaving your
>   custody. Built and tested; it activates once the operator configures the
>   delegation key and your escrow + session-key registration are on-chain — until
>   then, pay via mode (a) or the prepaid lane.
>
> See [x402 Payment API](../api/x402.md) for the precise per-lane scope.

## x402 facilitator

| Property   | Value                                   |
| ---------- | --------------------------------------- |
| Chain      | Solana                                  |
| Settle in  | USDC                                    |
| Wallets    | PDA smart-wallets supported             |

This matches the lobster.cash integration requirements (Solana, USDC, PDA).

## Payment states the surface handles

- **Wallet not configured** — prompts you to set up a wallet before paying.
- **Not enough balance** — reports the required amount; fund the wallet and retry.
- **Payment failure** — surfaces a clear error; the call is retryable.
- **Awaiting confirmation** — waits for the wallet to report final status before
  continuing.

> The fee on a priced call is split among the parties who created the value (the
> platform / indexer / route-owner split); the wallet just authorizes the
> payment. See [search-on-top](./search-on-top.md) for the search surface.
