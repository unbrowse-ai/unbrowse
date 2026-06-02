# Wallets & payments — bring your own wallet (Wallet Standard)

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

## Optional: the Unbrowse default wallet (just pay via API)

For web2 users who would rather not run a wallet at all, there's an **opt-in**
default: a Wallet Standard wallet whose signing is delegated to the Unbrowse
server, authorized by your API key. You never handle a seed phrase.

```ts
import { makeUnbrowseWallet, walletStandardPay } from "unbrowse/sdk/wallet-standard";

const wallet = makeUnbrowseWallet({ apiKey: process.env.UNBROWSE_API_KEY!, address, publicKey });
const unbrowse = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY, pay: walletStandardPay(wallet) });
```

It is optional and never forced: omit it and bring lobster.cash or any other
wallet. It exists only so "just let me pay via the API" is one line.

> Status: the client adapter is shipped; the server signing endpoint it calls
> (`/v1/wallet/sign`) is being wired (`wallet-sign-backend` in the plan). Until
> that lands, bring a Wallet Standard wallet (lobster.cash, Phantom, …) — those
> work today. This default activates once the signing endpoint is deployed.

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
