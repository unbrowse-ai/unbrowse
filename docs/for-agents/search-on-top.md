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

## Search is free — you pay when you *execute* a paid route

Discovery itself is **free**: `/v1/search` searches the route graph and adds
best-effort web (Exa) enrichment without charging per query. You only pay when
you **execute** a returned route that is priced — `unbrowse_execute` on a paid
endpoint settles **per-request over [x402](https://www.x402.org)**:

1. The execute request returns `402 Payment Required` with the price (USDC on Solana).
2. Your agent's **wallet** signs the payment and the request is retried — the
   client never sees or handles private keys.
3. On settlement you get the results plus a receipt.

**Bring your own wallet.** Payment execution, approval, and final status are
handled by the agent wallet, not by this skill. If a wallet step is required and
wallet context is missing, complete your wallet setup first. Any Solana wallet
that settles USDC over x402 works; agent wallets such as **lobster.cash** are
compatible and tested. The skill prepares the payment *requirements* (amount,
currency, reason) and delegates execution to the wallet.

### The fee split (on execution)

When a priced route executes, the fee is split **50 / 35 / 15** — platform /
indexer pool / route owner — so everyone who created the value gets their share.
The split is settled on-chain by the payment layer (Faremeter/Flex); the CLI/SDK
shows the same breakdown in the receipt (`computeSplit`,
`src/payments/split-constants.ts`). Web search via Exa is funded by the platform
(Exa is called with an API key), so discovery stays free to the caller.

### Payment states the surface handles (on a priced execute)

- **Wallet not configured** — prompts you to set up a wallet before executing.
- **Not enough balance** — reports the required amount; fund the wallet and retry.
- **Payment failure** — surfaces a clear error; the call is retryable.
- **Awaiting confirmation** — waits for the wallet to report final status before
  returning results.

## Route graph only (skip web enrichment)

Set `web: false` to search the route graph alone, without the Exa enrichment.

```ts
const routes = await unbrowse.search({ intent: "list GitHub repos", web: false });
```

> Implementation note: the surface (CLI/MCP/SDK) lives in this repo and calls the
> priced `/v1/search` route; the provider call and on-chain split are performed by
> the Unbrowse backend.
