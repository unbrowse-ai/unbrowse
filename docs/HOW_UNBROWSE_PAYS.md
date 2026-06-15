## What this document is

This page explains how money moves through Unbrowse on a paid call: what is free,
what costs, how a charge is split, and who signs for the wallet. Every claim cites
a file and line in the codebase so the behaviour can be verified, not just trusted.

## Free vs paid

Discovery and internal-API routing are free. When an agent asks Unbrowse to resolve
an intent, search cached endpoints, or read a route graph, nothing is charged.

Paid execution is the only billed step. When a workflow runs a captured route on
your behalf, that single call settles over x402 in USDC. There is no subscription
and no monthly plan: you pay per request, and only for the requests that execute.

## The split

Every paid call is divided by Faremeter Flex into a fixed, on-chain split. The
settlement roles are defined in `backend/src/services/flex.ts:39`, and the split
percentages are set by named basis-point constants:

- Platform: 50% (`PLATFORM_BPS = 5000`, see `backend/src/services/flex.ts:68`).
- Indexer / contributor pool: 35%, shared across the contributors who captured and
  maintain the route, weighted by their cumulative contribution.
- Domain owner: 15% (`OWNER_BPS = 1500`, see `backend/src/services/flex.ts:87`),
  carved off the top when a verified owner wallet is bound to the domain.

So a paid call with a bound domain owner settles as a **50/35/15** split: half to
the platform that runs the infrastructure, just over a third to the indexers who
discovered the route, and the rest to the website owner. When no owner wallet is
bound, the owner share folds back into the contributor pool.

## Brokered costs (fair compensation)

The split above taxes a route's **own price** — the opt-in lane. **Execution itself is free:
unbrowse takes no cut on the commons.** When unbrowse fronts a paid upstream on your behalf — a
web-unblocker for a hard-protected site, an LLM proxy, a paid third-party API, a facilitator or
gas fee — it passes the raw upstream cost straight through to you **at cost**, adding nothing.
You never pay unbrowse to execute; you only ever pay the genuine upstream, and only when one
exists.

The broker markup is a single named constant — **0% by default** (`FAIR_COMPENSATION_BPS`,
`backend/src/services/fair-compensation.ts`): a fronted upstream is pass-through-at-cost.
Monetization is opt-in and lives at the edge — an endpoint owner prices their own route and the
router tolls *that* (the Flex split above); a deployment can also opt into a broker markup via
env. Either way, every brokered ledger row records the raw `upstream_cost_uc` next to
`compensation_uc` (which is `0` unless someone has opted in), so the take-rate is auditable.

### `POST /v1/unlock` — brokered web unblocking

The first agent-facing brokered surface. When a site is behind hard anti-bot protection that
the local capture ladder can't clear, the agent hands the URL to unbrowse and pays once, in the
same Solana USDC x402 it already uses for routes:

```
POST /v1/unlock     { "url": "https://…", "js_render": true }
  → 402  with the sponsor envelope, priced at the raw upstream cost (pass-through; no markup by default)
  → agent pays (Flex x402, single payee — no Base wallet, no vendor signup)
  → unbrowse fronts the upstream web-unblocker on Base x402 and returns the cleared HTML
```

The response carries `x-unbrowse-charge-usd`, `x-unbrowse-passthrough-usd`, and
`x-unbrowse-compensation-bps` so the breakdown is visible on every call. The agent never holds a
Base wallet, never registers with the unblocker vendor, and never sees the vendor's payment
header — unbrowse holds one upstream account and brokers it for everyone
(`backend/src/routes/unlock.ts`, paying via `backend/src/services/base-x402-pay.ts`).

## Who signs the wallet

Unbrowse owns the payment intent: what is being paid for, how much, and to which
recipient token account. It does not own the wallet. Wallet ownership, session
lifecycle, and the sign and broadcast pipeline are delegated to an agent wallet.

The compatible and tested agent wallet is `lobster.cash`. Fund a `lobster.cash`
wallet once, and it pays each x402 challenge automatically. Unbrowse never creates
wallets and never asks for private keys, seed phrases, or raw card details.

## Seeing what your wallet received

Because the owner share is paid on-chain, the authoritative record is the wallet
itself: the USDC is already there. For a quick summary keyed by domain, a verified
owner can read `GET /v1/claim/earnings?domain=<your-domain>`, which sums the
owner-lane payouts across settled batches and returns the total earned, the count
of payouts, and the most recent settlement transaction. There is no balance to
release and no button to press: the read is a mirror of on-chain settlement, not a
withdrawal.

## Verify it yourself

The split constants above are read straight from the code. Run
`bash scripts/lobster-compat-gate.sh` to confirm Unbrowse's live x402 challenge
meets the wallet requirements (Solana settlement, USDC currency). The gate exits 0
when the contract holds, which is the runnable proof behind this page.
