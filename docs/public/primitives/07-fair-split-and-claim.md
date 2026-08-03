# Fair split and claim

## The rule

Every paid resolve or execute on an indexed route distributes its payment among three recipients via Faremeter Flex splits: the indexer who captured the route, the owner of the domain the route serves, and Unbrowse as the platform.

Domain owners are tied to their domains through the same verification flow used for opt-out (DNS TXT or `.well-known/unbrowse-optout`). The verification ties the domain to a Privy account and the wallet attached to it. Until a domain owner authenticates and claims, their accumulated share sits in a global holding wallet, attributed to the domain by reference, ready to transfer when claimed.

The split is fair. It rests on Faremeter's split mechanics, not on Unbrowse code that decides who gets what at request time.

## Who gets what

| Recipient | When they earn | Where the money goes |
|---|---|---|
| Indexer | Every time the route they captured is resolved or executed | The Solana wallet on the indexer's profile (`lobster-pay` wallet linked at registration) |
| Domain owner | Every time a route serving their domain is paid | The Privy wallet tied to the domain after verification — or the global holding wallet, attributed to the domain, until claimed |
| Unbrowse | Every paid Flex settlement we facilitate | Unbrowse's platform Solana wallet (Faremeter facilitator fee recipient) |

The splits are declared on the Faremeter Flex handler at settle time, not negotiated per request. The bps for each recipient are derived from contribution metrics on the ledger (how often the route resolves, how many indexed routes the indexer holds, the standard platform share). There is no per-domain pricing heuristic anywhere in the code.

## The Flex split shape

This is what the handler emits to the Faremeter facilitator on every settle:

```typescript
defaultSplits: [
  { recipient: indexerWalletATA,                bps: indexerBps },
  { recipient: domainWalletATA ?? globalHoldATA, bps: domainBps },
  { recipient: platformWalletATA,               bps: platformBps },
]
// indexerBps + domainBps + platformBps === 10000 (Faremeter convention)
```

When the domain has been claimed and a Privy wallet is bound, `domainWalletATA` is the bound wallet's USDC associated token account. When the domain has not been claimed, `globalHoldATA` is Unbrowse's holding wallet's USDC ATA. The Faremeter facilitator settles the split atomically on Solana; we do not move funds in application code.

When the global holding wallet receives a share, the backend appends one row to a public-visible ledger:

```
domain:<host> earned <amount> USDC on <iso-timestamp> via skill <skill-id> (settlement tx <signature>)
```

This is queryable at `GET /v1/domains/<host>/earnings` whether or not the domain has been claimed.

## The claim flow

1. The domain owner adds the DNS TXT record (or the well-known file) per [domain-opt-out](./06-domain-opt-out.md).
2. They visit `https://unbrowse.ai/domains/<host>/claim` and sign in with Privy (email or Solana wallet).
3. The backend verifies the proof of ownership (same verifier the opt-out flow uses) and binds `domain:<host>` to the Privy account in KV: `domain:<host>:privy = { privy_user_id, wallet_address, verified_at }`.
4. The backend reads the accumulated balance attributed to `domain:<host>` in the global holding wallet's ledger.
5. The backend signs and submits one transfer transaction from the global holding wallet to the now-bound domain wallet (USDC ATA to USDC ATA on Solana). The transfer is recorded in the public earnings ledger.
6. From the next paid settlement onward, the Flex split routes `domainBps` directly to the bound domain wallet — the global holding wallet is no longer in the path.

The claim is idempotent. A second claim on an already-claimed domain returns the bound wallet address and accumulated balance, without re-binding.

## Why the global holding wallet

Without it, a domain that has not yet been claimed by its owner has no recipient on the Flex split, and the share would have to either fall to the platform (unfair) or be skipped (the indexer would still get paid but the domain's share would be lost). The global holding wallet is the deliberate third option: the share accumulates, attributed to the domain, until the rightful owner claims it.

The holding wallet's balance is itself public. `GET /v1/global-hold/balance` returns the total; `GET /v1/global-hold/by-domain` returns the per-domain attribution.

## What happens when Faremeter mainnet is not reachable

The same Flex protocol runs on a self-hosted facilitator. When Faremeter's hosted facilitator is unavailable or x402 funds on the agent's side cannot reach mainnet, the runtime falls through to a Unbrowse-operated facilitator on a Tencent SSH host (referenced as `machine:faremeter-facilitator` in the contract platform). The split mechanics, the recipients, the claim flow are identical. The chain is never the blocker for the split being computed and recorded; settlement may delay until the host comes back if both are unreachable, but the attribution row is written either way.

This is the contract: payments either settle on Faremeter mainnet, or they settle on our self-hosted Faremeter facilitator, or the attribution row holds until one of the two recovers. The agent never sees a "we cannot pay you" error caused by chain availability.

## What this rules out

- Per-domain or per-indexer pricing tables in the application code. The split bps come from on-ledger metrics, not a hardcoded list.
- Application code moving funds. The Flex facilitator handles every transfer.
- A domain share being routed anywhere other than the domain wallet or the global holding wallet attributed to it. The platform does not take a domain's unclaimed share.
- A claim flow that requires anything beyond Privy authentication plus the same domain proof the opt-out flow uses.
- A failure mode where Faremeter chain availability blocks a route from being indexed or a recipient from being recorded.
