# Search-on-top — one search to find the route (or the web answer)

`unbrowse_search` (MCP) / `unbrowse search` (CLI) / `client.search()` (SDK) is the
single discovery surface on top of Unbrowse. Give it an intent; it finds the best
**route/skill** in the shared route graph, and when no indexed route fits it falls
back to a **live web search**. One call, ranked results — each hit carries
`skill_id` + `endpoint_id` where applicable so you can chain straight into
`unbrowse_execute`.

```ts
import { Unbrowse } from "unbrowse/sdk";
const unbrowse = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });

const hits = await unbrowse.search({ intent: "best machine learning frameworks" });
```

## It's a priced call — paid per request via x402

Search-on-top is a priced call. When the route graph misses and the query is
answered by a paid web-search provider, that cost is real, so the call settles
**per-request over [x402](https://www.x402.org)** rather than a subscription:

1. The request returns `402 Payment Required` with the price (USDC on Solana).
2. Your agent's **wallet** signs the payment and the request is retried — the
   client never sees or handles private keys.
3. On settlement you get the results plus a receipt.

**Bring your own wallet.** Payment execution, approval, and final status are
handled by the agent wallet, not by this skill. If a wallet step is required and
wallet context is missing, complete your wallet setup first. Any Solana wallet
that settles USDC over x402 works; agent wallets such as **lobster.cash** are
compatible and tested. The skill prepares the payment *requirements* (amount,
currency, reason) and delegates execution to the wallet.

### Pricing & the fee split

Pricing mirrors the upstream web-search provider's x402 pricing plus the
marketplace fee. The current web-search provider is **Exa** (`api.exa.ai`), which
itself settles over x402 — e.g. `$0.007` for a standard search, `$0.001` per
fetched page — so the cost is a transparent pass-through. The fee is split **50 / 35 / 15** — platform / indexer pool / route owner —
so everyone who created the value gets their share. The split is settled on-chain
by the payment layer (Faremeter/Flex); the CLI/SDK shows the same breakdown in
the receipt (`computeSplit`, `src/payments/split-constants.ts`).

### Payment states the surface handles

- **Wallet not configured** — prompts you to set up a wallet before searching.
- **Not enough balance** — reports the required amount; fund the wallet and retry.
- **Payment failure** — surfaces a clear error; the call is retryable.
- **Awaiting confirmation** — waits for the wallet to report final status before
  returning results.

## Route graph only (no web, no charge for cached hits)

Set `web: false` to search the route graph alone. A cached route hit costs
nothing; you only pay when the search reaches a paid provider.

```ts
const routes = await unbrowse.search({ intent: "list GitHub repos", web: false });
```

> Implementation note: the surface (CLI/MCP/SDK) lives in this repo and calls the
> priced `/v1/search` route; the provider call and on-chain split are performed by
> the Unbrowse backend.
