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
