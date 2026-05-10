# Earnings & Rewards

Four typed methods on `Unbrowse` cover the dashboard / transactions / attribution surface. No more `request<T>()` escape hatch.

## Methods

```ts
u.dashboard(options?)                          // GET /v1/dashboard/me           (auth required)
u.dashboardByWallet(walletAddress, options?)   // GET /v1/dashboard/wallet/:address
u.creatorTransactions(agentId, options?)       // GET /v1/transactions/creator/:agentId
u.indexerAttribution(indexerId, options?)      // GET /v1/attribution/indexer/:indexerId
```

All return typed responses from `@unbrowse/sdk`'s `contracts.ts`.

## Reading your own earnings

```ts
import { Unbrowse } from "@unbrowse/sdk";

const u = new Unbrowse({ apiKey: process.env.UNBROWSE_API_KEY });
const me = await u.dashboard();

console.log(me.earnings?.total_usd, me.earnings?.unsettled_usd);
for (const skill of me.earnings?.by_skill ?? []) {
  console.log(skill.skill_id, skill.executions, skill.usd);
}
```

`dashboard()` is bearer-gated; the SDK auto-attaches `Authorization: Bearer ${apiKey}` when `apiKey` is set.

## Reading any wallet (public)

```ts
const byWallet = await u.dashboardByWallet("<solana address>");
console.log(byWallet.earnings?.total_usd);
```

No auth required — used for leaderboards, partner integrations, public profile pages.

## Per-transaction ledger

```ts
const { ledger, transactions } = await u.creatorTransactions("agent_abc123");
console.log(ledger?.total_usd, ledger?.unsettled_usd);
for (const tx of transactions ?? []) {
  console.log(tx.tx_id, tx.skill_id, tx.amount_usd, tx.settled_at);
}
```

Use this when you want to drill from aggregate earnings into individual settlement events.

## Indexer attribution

For the role that captures and indexes routes (vs. publishes):

```ts
const attribution = await u.indexerAttribution("indexer_abc123");
console.log(attribution.total_usd);
for (const skill of attribution.by_skill ?? []) {
  console.log(skill.skill_id, skill.executions, skill.usd);
}
```

## Same data via CLI

```bash
unbrowse stats --earnings
unbrowse stats --json
```

## Wallet configuration

Wallet address is read in this order at runtime (`src/payments/wallet.ts`):

1. `LOBSTER_WALLET_ADDRESS` env var
2. `AGENT_WALLET_ADDRESS` env var
3. Local Crossmint Lobster config (`~/.lobster/agents.json`), detected automatically by `unbrowse setup`

To (re)configure:

```bash
npx @crossmint/lobster-cli setup
unbrowse setup
```

There is no standalone wallet subcommand on the CLI.

## Reading the splits

From `backend/src/services/splits.ts`:

- **90% to the contributor pool** (publishers, indexers, attributed roles)
- **10% platform fee**

The 90% is divided across the contributor pool by attribution weight; verify against the live `creatorTransactions` and `indexerAttribution` for your wallet rather than assuming a fixed sub-split.

See [Rewards & economics](../../../../docs/sdk/rewards-and-economics.md) for the full model.
