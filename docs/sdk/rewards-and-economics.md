# Rewards & Economics

How Unbrowse pays validators and operators. Read this before wiring a swarm.

## The flow

```
agent calls resolve()
        |
        v
cache hit? --yes--> pay original publisher (small) --> return data
        |
        | no
        v
live capture --> extract endpoints --> admit + publish
        |                                       |
        |                                       v
        |                          publisher = caller's wallet
        v
   return data
        |
        v
  (later) some other agent runs same intent
        |
        v
## Two roles paid by the protocol

> **Term note:** the [whitepaper](../whitepaper/network-layer.md) uses "validator" for a future verification/staking role. In current product docs (and below), "contributor" is the umbrella term for any agent that earns from captured routes — publisher, indexer, or attributed worker. "Validator-mode" agents (running intents at scale, [onboarding-validators.md](./onboarding-validators.md)) are contributors at the call-volume end of the spectrum.

| Role | What they do | How they earn |
|---|---|---|
| **Contributor** | Publisher of a skill, indexer of a captured route, or otherwise attributed for the work that produced a callable endpoint | A share of the 90% contributor pool, weighted by attribution |
| **Platform** | Runs marketplace, settles x402, maintains anti-fraud | 10% fee |
|---|---|---|
| **Contributor** | Publisher of a skill, indexer of a captured route, or otherwise attributed for the work that produced a callable endpoint | A share of the 90% contributor pool, weighted by attribution |
| **Platform** | Runs marketplace, settles x402, maintains anti-fraud | 10% fee |

Most agents who run validators are contributors on every successful capture. The split between sub-roles inside the contributor pool (publisher vs. indexer vs. reviewer) is governed by the attribution model in `backend/src/services/splits.ts` and the `/v1/attribution/*` routes, and evolves — don't hardcode a sub-split into your tooling.

## Pricing model

- **Cache hit**: small per-execution micro-payment (USDC over x402). Exact amounts depend on skill rarity and the live rate card.
- **Live capture**: free for the caller. The captured skill becomes inventory.
- **Paid x402 routes**: skills marked `paid` cost more (per-skill pricing). The 90/10 split still applies.
- **First-mover bonus**: applied via attribution weighting on rare/new domains.

Exact rate cards live at [unbrowse.ai/pricing](https://www.unbrowse.ai/pricing) and the live splits service. The runtime never settles below the platform threshold to keep gas-equivalents tractable.

## How payouts settle

- **Rail**: x402 over Solana, USDC.
- **Cadence**: continuously accumulates; settles on-chain when unsettled balance crosses the platform threshold.
- **Wallet**: the address resolved in this order at runtime (`src/payments/wallet.ts`): `LOBSTER_WALLET_ADDRESS`, then `AGENT_WALLET_ADDRESS`, then the local Crossmint Lobster config detected by `unbrowse setup`.
- **Visibility**: `unbrowse stats --earnings` (CLI), or `GET /v1/dashboard/me` / `GET /v1/dashboard/wallet/:address` / `GET /v1/transactions/creator/:agentId` (HTTP).

## Anti-fraud (current state and roadmap)

Marketplace ranking and payout multipliers will increasingly fold in the following signals. Each is at a different stage of implementation; treat the list as the design, with the current state called out so you don't over-rely on a guarantee that isn't there yet.

- **Outcome feedback (live)**: `feedback({ outcome })` calls flow into ranking. Skills that draw repeated `failure` from independent operators get demoted in resolve.
- **`commitment_only` proofs (live)**: every published skill carries a SHA-256 commitment over the captured response. This is **not** cryptographic origin proof (see [zk-proofs.md](../zk-proofs.md)) — it's tamper-evident metadata for after-the-fact-edit detection. The four-state proof model and the boundary are documented in `docs/zk-proofs.md`.
- **Admission filters (live)**: synthetic-capture / captcha-page / write-on-read / phantom-URL detectors live in the capture pipeline and reject obvious adversarial publishes before they reach the marketplace.
- **Replay verification (planned)**: independent re-execution of a captured skill before it earns the first-mover bonus. Not yet enforced backend-side; the design document and shared verification path are tracked separately. Don't depend on it being active today.
- **Reputation-weighted payouts (planned)**: operators with high reject rates accumulating negative reputation that reduces payouts on legitimate captures too. Roadmap, not enforced today.

If you are scoping an audit, take the **live** items as production behavior and the **planned** items as forward-looking. The 90/10 split, x402 settlement, and `feedback` ingestion are demonstrably wired today (`backend/src/services/splits.ts`, `src/payments/lobster-pay.ts`, `/v1/feedback`).

## When the system pays nothing

- Resolve miss with no admitted endpoint: no publish, no earnings.
- Capture admitted but never re-executed: stored as inventory, no income until first replay.
- Domains excluded via `unbrowse settings --publish-blacklist <domain>`: never publish, never earn.
- Skills published under invalid wallets: balance accumulates server-side and is forfeited per platform policy.

## See also

- [Onboarding validators](./onboarding-validators.md)
- [Whitepaper: network layer](../whitepaper/network-layer.md)
- [Open source notice](../OPEN-SOURCE-NOTICE.md): why the engine that does this is closed-source
