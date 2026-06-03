# How the platform fee cycles back to FDRY stakers

This page is the companion to [HOW_UNBROWSE_PAYS.md](HOW_UNBROWSE_PAYS.md). That
document explains how money lands on every paid call (the 50/35/15 split between
platform, indexer pool, and domain owner). This document explains **what happens
to the platform's 50%**: how it cycles back to FDRY stakers through an on-chain
staking vault and net-asset-value (NAV) growth.

> **A note on framing.** FDRY is collateral for trust, not a currency or an
> investment. This page describes how value cycles to participants who stake and
> keep the route graph maintained. Nothing here is a promise of profit, an offer,
> or a solicitation. The NAV mechanics below describe accountable participation in
> the maintenance layer, not a return. You never need to hold FDRY to use Unbrowse:
> usage settles in USDC, and FDRY exists only to bond accountable maintenance.

## TL;DR

1. Every paid `unbrowse execute` settles via Faremeter Flex. The platform's 50%
   lands as USDC at the platform recipient token account.
2. An off-chain revenue-routing job takes that USDC, swaps it for FDRY on a DEX,
   and deposits the FDRY into a staking vault.
3. The vault mints **stFDRY** (the staking receipt) to stakers. Every deposit
   raises NAV-per-share, so existing stFDRY appreciates against a larger vault.
4. Stakers hold through a fixed cooldown. Participants whose maintained routes are
   proven to have failed are slashed; the slashed stake returns to the vault,
   raising NAV for the remaining stakers.
5. The pricing and split constants are pinned in code and gated at build time, so
   a binary whose economics drift from these rules will not ship.

## The token, the vault, the receipt

| Asset | Role |
|---|---|
| **FDRY** (SPL token) | The stake-layer asset. Mint address is public on Solana mainnet. |
| **Staking vault** (Voltr / Ranger) | Receives FDRY deposits; mints stFDRY. Address resolved at runtime, not pinned here. |
| **stFDRY** | The staking receipt. NAV grows under it as revenue routes in. |
| **USDC** (mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) | The settlement layer. Usage is always paid in USDC, never in FDRY. |

The USDC-vs-FDRY separation is a design requirement: one token cannot be both the
payment surface and the security layer. USDC handles usage; FDRY is reserved for
stake. This anti-conflation rule is enforced by the build-time parity check on the
pricing constants: a change that tried to make FDRY accept x402 payments would fail
the check and the binary would not sign.

## The revenue cycle

```
unbrowse execute (paid call)
   |
   |- Faremeter Flex authorization, up to 5 recipients
   |    |- Platform   (50% default) -> platform USDC token account
   |    |- Site owner (15%, when DNS-claimed)
   |    |- Indexer pool (35%, split by cumulative contribution)
   |
   |- Platform's 50% accumulates at the platform recipient
   |    (PLATFORM_BPS = 5000)
   |
   |- Revenue-routing job (operator-triggered today)
   |    |- swap USDC -> FDRY on a DEX
   |    |- deposit FDRY into the staking vault
   |    |- vault mints stFDRY; NAV-per-share rises with the deposit
   |
   |- Routing receipt recorded
```

The routing job runs in dry-run by default and is operator-triggered today (run
when accumulated platform USDC clears a useful swap size). Automating it on a
schedule is on the roadmap (see the status table below).

## What a staker actually sees

When you hold stFDRY, every revenue-routing event raises your NAV-per-share: the
same number of shares now claims a larger slice of the vault. To realize that gain
you either:

1. **Hold for the long term.** NAV growth compounds: active routing grows the
   vault, and existing stFDRY appreciates against a larger asset base.
2. **Initiate withdrawal.** A fixed cooldown (3 days) is enforced at the vault
   program level. After it, you redeem stFDRY into FDRY and sell or hold.
3. **Get slashed.** If a maintained route is proven to have failed by an
   independent witness quorum, the responsible stake is slashed to the vault,
   raising NAV for everyone who stayed.

The asymmetry — staking earns, abandoning a failed route is penalized, and the
penalty concentrates value in the stakers who stayed — is what makes this an active
maintenance economy rather than a passive holding pool. There is a reason to stay
through the cooldown, and a cost to walking away from a route you committed to.

## Live vs. pending

The full model is larger than what ships today. We surface the gap rather than hide
it.

| Claim | Status |
|---|---|
| FDRY is the canonical stake asset (deployed mint) | Live |
| Staking vault accepts FDRY and mints stFDRY | Live |
| 3-day withdrawal cooldown (vault program level) | Live |
| Platform earns 50% of every Flex settlement | Live |
| Manual buyback: route revenue USDC -> FDRY -> vault deposit | Live |
| Per-call signed request identifies the calling wallet server-side | Live |
| 402 response surfaces the caller's wallet balance | Live |
| Automated, scheduled buyback (no manual trigger) | Pending |
| stFDRY stake balance surfaced in the 402 response | Pending |
| Stake-tier eligibility predicate | Pending |
| Witness-quorum slashing hook | Pending |
| Treasury onramp to auto-fund unfunded wallets | Pending |

The auth-first ordering on the declare path and the balance probe in the 402
response are the observation layer the pending pieces fire from: the platform
already knows, on every paid call, which wallet is calling and what its balance is.
The onramp, tier predicate, and slashing hook each read that same data when built.

## How to participate today

1. **Acquire FDRY** on Solana mainnet (the public mint).
2. **Deposit to the staking vault** via the vault UI or SDK. You receive stFDRY
   proportional to the vault's current NAV-per-share.
3. **Hold stFDRY.** Every revenue-routing event raises NAV; your share count stays
   the same while what it claims grows.
4. **When ready to exit, initiate withdrawal.** The 3-day cooldown applies.

## Why the design refuses the easy paths

Three patterns that would be simpler but are deliberately rejected:

- **A fee-distribution contract that pushes USDC pro-rata to holders.** Rejected:
  it makes the holder queue for a payout at a block height. NAV growth via vault
  deposits distributes the same value, but the staker claims it by holding, not by
  showing up at the right moment.
- **A separate stake-reward emission token.** Rejected on one-token-one-purpose
  grounds: emission tokens fragment attention and dilute alignment.
- **A governance vote on slashing.** Rejected: slashing fires on a quorum of
  independent witnesses with verifiable signatures, not a token-weighted vote.
  Slashing is a matter of evidence, not opinion; stake cannot purchase forgiveness
  for a failed route.
