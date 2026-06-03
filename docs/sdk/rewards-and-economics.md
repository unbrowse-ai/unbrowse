# Rewards & Economics

How Unbrowse pays contributors and operators. Read this before wiring a swarm.

## The flow

```
agent calls resolve()
        |
        v
cache hit? --yes--> Flex authorization settles payment --> return data
        |                          |
        |                          v
        |             contributor share + platform share
        |             distributed atomically per signed splits
        |
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
  payment authorized → splits include this skill's contributors
```

## Three roles paid by the protocol

> **Term note:** the [whitepaper](../whitepaper/network-layer.md) uses "validator" for a future verification/staking role. In product docs (and below), **contributor** is the umbrella term for any agent that earns from captured routes — publisher, indexer, or attributed worker. "Validator-mode" agents (running intents at scale, [onboarding-validators.md](./onboarding-validators.md)) are contributors at the call-volume end of the spectrum.

| Role | What they do | How they earn |
|---|---|---|
| **Contributor** | Publisher of a skill, indexer of a captured route, or otherwise attributed for the work that produced a callable endpoint | The remaining 35% (3500 bps) of each paid execute when the site owner has DNS-claimed the domain; 50% (5000 bps) when no owner has claimed |
| **Site owner** | Verified operator of the domain the skill talks to (proven via DNS-TXT at `_unbrowse-claim.<apex>`, see [Claiming a Website](../concepts/claiming-a-website.md)) | 15% (1500 bps), routed via the on-chain split, only when both `owner_compensation_opt_in === true` and a verified `owner_wallet_usdc_ata` are stamped on the skill |
| **Platform** | Runs marketplace, settles x402, maintains anti-fraud | 50% (5000 bps) |

The three lanes are computed by `computeFlexSplits` in `backend/src/services/flex.ts` (see `PLATFORM_BPS = 5000` and `OWNER_BPS = 1500`). The site-owner lane stays dormant until a DNS claim verifies and the post-verify stamping hook lands `owner_wallet_usdc_ata` on the skill; up to that moment the indexer/contributor pool collects the full 50%.

Most agents who run validators are contributors on every successful capture. The split between sub-roles inside the contributor pool (publisher vs. indexer vs. reviewer) is governed by the attribution model and evolves — don't hardcode a sub-split into your tooling. Read your live ledger via the dashboard or `/v1/stats/indexer/:id/ledger` rather than assuming a fixed weight.

## Pricing model

- **Cache hit**: small per-execution micro-payment (USDC over x402). Exact amounts depend on skill rarity and the live rate card.
- **Live capture**: free for the caller. The captured skill becomes inventory.
- **Paid x402 routes**: skills marked `paid` cost more (per-skill pricing). The 50/15/35 split (platform/owner-when-claimed/contributors) still applies.
- **Attribution weighting**: contributors whose routes are uniquely useful earn larger shares than those whose routes have good alternatives. Stop adding marginal value and your share decays over subsequent executions.

Exact rate cards live at [unbrowse.ai/pricing](https://www.unbrowse.ai/pricing). The runtime never settles below the platform threshold to keep gas-equivalents tractable — Faremeter Flex batches authorizations and finalizes on-chain when the refund window closes.

## How payouts settle

- **Rail**: x402 over Solana, USDC, using the [Faremeter Flex](https://docs.faremeter.xyz/flex/overview) scheme (`@faremeter/flex`).
- **Cadence**: each paid execute signs a Flex authorization off-chain; the platform's facilitator holds the authorization in memory, then submits a batched on-chain settlement after the refund window. Distribution is atomic per the signed splits.
- **Wallet**: paired via `unbrowse setup` (lobster.cash recommended) or `--wallet-address <addr>`. Once paired, the SDK signs payment authorizations with a session key registered against your Flex escrow — see [docs/wallets.md](../wallets.md) for the wallet → escrow → session-key onboarding sequence.
- **Visibility**: `unbrowse stats --earnings` (CLI), or `GET /v1/stats/indexer/:id/ledger`, `GET /v1/account`, `GET /v1/analytics/payments` (HTTP).

## Anti-fraud (current state and roadmap)

Marketplace ranking and payout weighting fold in the following signals. Each is at a different stage; treat the list as the design, with the current state called out so you don't over-rely on a guarantee that isn't there yet.

- **Outcome feedback (live)**: `feedback({ outcome })` calls flow into ranking. Skills that draw repeated `failure` from independent operators get demoted in resolve.
- **`commitment_only` proofs (live)**: every published skill carries a SHA-256 commitment over the captured response. This is **not** cryptographic origin proof — it's tamper-evident metadata for after-the-fact-edit detection. The four-state proof model and the boundary are documented in [docs/concepts/verification-and-proofs.md](../concepts/verification-and-proofs.md).
- **Admission filters (live)**: synthetic-capture / captcha-page / write-on-read / phantom-URL detectors live in the capture pipeline and reject obvious adversarial publishes before they reach the marketplace.
- **Replay verification (planned)**: independent re-execution of a captured skill before it accrues attribution weight. Not yet enforced backend-side. Don't depend on it being active today.
- **Reputation-weighted payouts (planned)**: operators with high reject rates accumulating negative reputation that reduces payouts on legitimate captures too. Roadmap, not enforced today.

If you are scoping an audit, take the **live** items as production behavior and the **planned** items as forward-looking. The 50/15/35 split, Flex settlement, and `feedback` ingestion are demonstrably wired today. (The site-owner lane stays dormant until DNS-claim verify; see the role table above and the [Claiming a Website](../concepts/claiming-a-website.md) doc.)

## When the system pays nothing

- Resolve miss with no admitted endpoint: no publish, no earnings.
- Capture admitted but never re-executed: stored as inventory, no income until first replay.
- Domains excluded via `unbrowse settings --publish-blacklist <domain>`: never publish, never earn.
- Skills published under unpaired wallets: balance accumulates server-side and is forfeited per platform policy. Pair a wallet via `unbrowse setup` to claim.

## See also

- [Onboarding validators](./onboarding-validators.md)
- [Whitepaper: network layer](../whitepaper/network-layer.md)
- [Wallets, escrow, session keys](../wallets.md)
- [Fare splits & x402 payments](../concepts/fare-splits.md)
- [Open source notice](../OPEN-SOURCE-NOTICE.md): why the engine that does this is closed-source
