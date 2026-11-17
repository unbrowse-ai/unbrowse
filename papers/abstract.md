# Unbrowse in one page

<style>@page{size:A4;margin:11mm 13mm} html{font-size:7.8pt;line-height:1.25} h1{font-size:15.5pt;margin:0 0 1mm} h2{margin:2mm 0 0.6mm;font-size:10pt} p,ul{margin:0.6mm 0} li{margin:0.15mm 0} table{margin:0.8mm 0;font-size:7.4pt} td,th{padding:0.4mm 1.3mm} pre{font-size:6.6pt;line-height:1.15;margin:0.8mm 0} body{line-height:1.25} h1+p{margin-bottom:1.1mm;padding-top:0.8mm;font-size:7.3pt} table+p{margin:0.6mm 0;font-size:7.4pt}</style>

**Lewis Tham** · Unbrowse · 11 November 2026 · *Protocol design, not yet open. UNB is live on Arc mainnet; the route-coin contracts ship as a new deployment after review, audit and the closed pilot. Numbers fill from `protocol/params.toml`, governed by the Unbrowse design graph.*

## What Unbrowse does, and why

Every website already exposes a structured API to its own pages: the HTTP requests fired when a user searches, filters or submits a form. Today, AI agents reach those interfaces the slow way, launching a browser, waiting for scripts, paying a model to read HTML, and discarding how they got the answer so the next agent repeats the work. With Unbrowse, an agent's local node watches a page once, captures that underlying request, strips personal credentials into local vault placeholders, and saves a reusable **route** that runs in milliseconds as plain HTTP. Because each recipe is named by the hash of its bytes, any peer that paid for it can re-serve it without altering a byte, and logins never leave the caller's machine. Smart contracts on Arc settle fees and hold stake; discovery, ranking and calls run peer to peer.

## Who pays, and in what

Agents pay in dollars (USDC), never in UNB. Each lister prices its own route down to $0.000001 with no protocol floor, so equivalent routes compete on price. A caller pays once to fetch a route version and reuses its cached copy for free while it works. A failed fetch costs nothing, however many fail, so trying an unfamiliar route carries no risk; the cost is that a payer that falsely marks fetches failed is not stopped on chain. Every passed fee splits in the settlement contract:

| Share | Recipient and purpose |
|---|---|
| 65% | **The route:** pays verified stakers in USDC and uses the rest to buy and stake the route's coin for the caller |
| 30% | **The website** whose API the route calls, held in escrow until the domain owner proves control |
| 5% | **Buy-and-burn:** swapped for UNB and permanently destroyed |

Neither the serving peer (0%) nor the platform (0%) takes a cut of route fees.

## Why UNB exists, and what it does

Keeping a shared API map accurate is a commons problem: sites change silently, and paid third-party raters rubber-stamp results instead of checking. Unbrowse turns paying callers into staked verifiers, priced in UNB:

- **Backing every route coin.** Each distinct route body can launch one fixed-supply coin (1,000,000,000 units) on a curve against UNB, opened only by a purchase from its lister or a bounty. Earliest buyers pay least.
- **Turning fetches into ownership.** Every coin in the fixed supply has an equal claim on the route's 65% share. Coins staked before the epoch by verified wallets earn their share in USDC; the rest swaps into UNB, buys the coin for the caller, and stakes it automatically. Early fetches mostly buy coins; mature fetches mostly pay USDC yield. Callers never handle UNB.
- **Ranking working routes over broken ones.** Clients pick routes in proportion to `S = √(Q · M)`, combining verified staked collateral whose holders' latest paid call passed (`Q`) with time-weighted market cap (`M`). When a site changes, failing calls pull users' stake out of `Q` and zero yield pushes holders to sell, while an updated route body launches a fresh coin that overtakes the broken one as callers fetch it.
- **Bounties and burns.** Anyone needing an unmapped site can post a UNB bounty as a limit order released by verified use. Separately, 5% of every fee plus a decaying 50% snipe tax in a coin's first 5 minutes buy UNB and burn it. UNB carries no vote and pays nothing for passive holding.

## Supply and allocation

Fixed at 1,000,000,000 UNB, minted once on Arc mainnet with 0 UNB minted afterward; burns only shrink supply.

| Allocation | Share | Unlock terms |
|---|---|---|
| Public launch pool | 67% | Open market in UNB's public pool on Arc (proposed share) |
| Rewards reserve | 10% | Utility contract; posts hourly listing roots only, never bounties or yield |
| Treasury | 5% + 10% | Cliff-locked 3 months and 6 months from genesis |
| Team (including investors) | 8% | Cliff-locked 3 months from genesis |
| Airdrop | 0% | None |

The team intends to buy up to 7% at launch from disclosed wallets (insider holdings, never outside demand). UNB's pool charges a 4% swap fee (paid once per swap) to fund Unbrowse; route-coin trades pay 1% to the platform.

## Value flow

```text
caller ──USDC fee──▶ Settlement ─┬─ 30% website ──▶ domain escrow (claimed by DNSSEC proof)
                                 ├─  5% burn    ──▶ swap to UNB ──▶ burned
                                 └─ 65% route   ─┬─ verified prior stakers ──▶ paid pro rata in USDC
                                                 └─ remaining supply share ──▶ swap to UNB ──▶ buy & stake coin for caller
```

## Principal risks and trade-offs

- **Price risk:** UNB and every route coin can fall; nothing promises a floor or return.
- **Capital trade-offs:** Dropping identity weights stops Sybil games, so locked capital can buy rank (failed calls stay free and pay $0), a heavily funded copy can out-earn backing an under-staked original, and dormant holders slow a broken route's decay. Insiders can sell ahead of a site break they spot early.
- **Stage, audit and legal:** Evidence comes from bounded Quint models, not live traffic. Contracts await proof, audit and counsel review (`protocol/spec/11-launch.md`); the founder remains the main trust point until community listings overtake initial coverage.

*Design summary only; not an offer of any token or a promise of any return. Normative rules: `protocol/spec/`.*
