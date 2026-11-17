# Paying for the Map: The UNB Economy

**Lewis Tham** · Unbrowse · lewis@unbrowse.ai · 11 November 2026 · *Protocol design, not yet open. UNB is live on Arc mainnet; the route-coin contracts ship as a new deployment after review, audit and the closed pilot. Numbers come from `protocol/params.toml`, governed by the Unbrowse design graph. Companion to "On Indexing the Entire Internet's APIs for Agents".*

> **UNB in brief.** Agents pay to fetch routes in dollars (USDC), never in UNB, at prices each route's lister sets. UNB is live on Arc mainnet with a fixed supply of 1,000,000,000 UNB, minted once at genesis with 0 UNB minted afterward. Every distinct route recipe can launch its own fixed-supply coin on a curve against UNB, pricing both the stake behind a route and the rank clients use to choose it. When a paid fetch passes, the route's 65% share pays existing verified stakers in USDC and swaps the remainder into UNB to buy and stake that route's coin for the caller, while 5% buys UNB and burns it. Anyone needing an unmapped site can post a UNB bounty as a limit order. Unbrowse's team (8%) and treasury (5% and 10%) are cliff-locked 3 months and 6 months, with no airdrop. UNB carries no vote, pays nothing for passive holding, and can fall in value; nothing here promises a return.

## Abstract

Unbrowse is a peer-to-peer index of websites' internal APIs, allowing software agents to replace slow browser sessions with direct HTTP requests. This companion paper explains how money and ownership move through that index. Callers pay once per route version in USDC at prices set freely by each lister, and reuse cached recipes locally at zero cost while they work. Every passed fetch fee splits on chain: 65% to the route, 30% to escrow for the target website, and 5% to buy and burn UNB. Rather than paying a perpetual royalty to whoever uploaded a route first, the protocol gives each distinct route body its own fixed-supply coin traded against UNB on a bonding curve. Each passed fetch pays verified prior stakers their share of the supply in USDC and swaps the rest into UNB to buy and stake the route's coin for the caller. Bounties for unmapped sites operate as price-capped limit orders in UNB, released by verified use. With a fixed UNB supply and zero post-genesis issuance, every flow touching UNB stems directly from paid route adoption.

## 1. Introduction

A route is a reusable recipe for calling a website's internal API; an entry is one byte-exact version of that recipe, addressed by its cryptographic hash. Running a known route over HTTP costs almost nothing, yet keeping an open index of routes accurate is expensive because websites change without warning. An economic design for that index has a single job: reward the people who discover and back routes that currently work, and cut off that reward as soon as a route stops working.

Conventional marketplaces try to do this with perpetual creator royalties, paid reviewers or slashable bonds. Each introduces its own failure mode: creators collect rent after abandoning upkeep, paid reviewers rubber-stamp results to farm fees, and upfront bonds lock out independent builders. Unbrowse aligns incentives by turning callers into staked owners. Paying to fetch a working route automatically buys and stakes a share of that route's coin, and staked coins earn USDC fees only for wallets that have verified the route in real use. When a route breaks, failed calls pay nothing and pull users' stake out of its ranking, starving dead entries while callers fund working replacements.

Sections 2 to 5 explain who pays, how fees split, how websites claim escrow, and why failed calls are free; Sections 6 to 10 detail UNB's role, route coins, the pay-then-buy lifecycle, staking and limit-order bounties; Sections 11 and 12 cover genesis supply, locks and Unbrowse's own holdings; Section 13 traces every fee flow and source of UNB demand; and Section 14 states the economic risks and open questions.

## 2. Why callers pay once in dollars

Forcing developers to buy a volatile protocol token before their agent can read a web page creates accounting friction and exposes everyday API budgets to market swings. Agents on Unbrowse therefore price, deposit and pay strictly in USDC, which also serves as native gas on Arc. Callers never hold or manage UNB.

When an agent misses on a task and finds a matching listing on the peer network, its node signs an off-chain EIP-712 payment voucher from its USDC deposit (capped by default at $0.05 per fetch and $5.00 per epoch) and fetches the recipe bytes. Once verified, the node caches the recipe locally and executes every subsequent call to that version directly against the website at $0 protocol cost. On-chain payments therefore measure **adoption and version turnover**, one paid line per caller per working recipe version, rather than raw HTTP request volume.

Nobody sets a central tariff. Each lister names its own USDC price schedule down to $0.000001, optionally varying by a caller's public track record, and the client software suggests no default price. Because equivalent entries for the same task compete side by side within callers' budget caps, a lister who overcharges loses traffic to peers pricing closer to marginal cost. Searching the hash table is free, executing cached routes is free, and there are no protocol execute tolls or skill fees.

## 3. The three-way fee split

When a payee submits a passed voucher line to the settlement contract, the contract divides the USDC price `p` into three parts:

| Share | Destination | Economic purpose |
|---|---|---|
| 65% | **The route** | Pays verified prior stakers in USDC and buys staked coins for the caller (or pays the credited lister if uncoined) |
| 30% | **Website escrow** | Compensates the domain whose backend served the underlying API call |
| 5% | **Buy-and-burn** | Batch-swapped once per epoch into UNB and permanently destroyed (absorbs integer rounding) |

Neither the peer that served the recipe bytes (0%) nor the platform (0%) takes a cut of route fees. Removing side cuts keeps settlement transparent and removes incentives to spoof serving hops. Serving a content-addressed file of a few kilobytes costs negligible bandwidth, and nodes that seed routes they rely on earn through their own staked coins on those routes; meanwhile, the platform funds maintenance from trading fees rather than taxing API fetches.

Fee shares are immutable constants of the deployed contracts. The initial v2 settlement contract currently on mainnet continues paying its earlier five-way split until the route-coin deployment ships and peers migrate voluntarily.

## 4. Paying websites without asking permission

Agents skipping rendered web pages also skip a site's display ads, so a sustainable machine web should share revenue with the publishers running the backends. Every passed line automatically credits 30% of its USDC fee to an on-chain escrow bucket keyed by the target domain, whether or not the website operator has ever heard of Unbrowse.

A domain owner claims its accrued balance at any time without posting a bond. Domains with DNSSEC prove ownership trustlessly on chain via a signed TXT record naming their wallet; after a 14 epochs security wait, accumulated USDC releases and future shares stream directly to that wallet. DNSSEC is the only proof: a domain without it enables DNSSEC with its DNS provider before it can claim, and its share keeps accruing in escrow meanwhile (`decide.dnssec-only`). Verified domain owners may also set a minimum fee floor for routes calling their site, while any site can opt out of Unbrowse traffic immediately and for free by disallowing `Unbrowse` in `robots.txt`. How long-unclaimed escrow is handled remains open.

## 5. Failed fetches are free

Anyone can list a route for free, so a buyer needs protection against broken or stale recipes. If a fetched route returns an error status, redirects off-site, fails schema validation or returns empty data, the caller's client signs a failed receipt line, and Settlement charges nothing for it and pays nobody, however many of the payer's fetches fail. An earlier cap billed payers in full past a quarter of their paid lines, charging them for breaks they did not cause; the owner removed it.

The cost is plain. The payer signs pass or fail itself, so a payer that signs every fetch failed gets every answer unpaid and keeps the body, and nothing on chain bounds it. A server earns nothing from such a payer and may stop serving it on its own judgment; no network rule makes it.

The coin limits who gains. A fetch signed failed pays no fee, so it buys the payer none of the route's coin (§8), and a wallet that has never paid for a passed call has not checked the route, so coin it buys on the curve earns nothing. A caller that wants to hold a route therefore pays for its fetch, and the lie pays only a caller that wants no stake.

Free failures also do economic work: a broken route's failed lines pay $0, so stakers on a dead route lose all of their USDC cash flow at once.

## 6. What UNB does

While USDC handles everyday payments, UNB serves as the scarce capital asset coordinating ownership, ranking and cold-start discovery across the map:

- **Numeraire for every route coin.** Each route coin trades against UNB on its bonding curve, denominating route market caps and collateral in UNB.
- **Automatic settlement conversion.** Whenever a passed fetch buys route coins for its caller, the contract swaps that portion of the USDC fee into UNB through UNB's public pool inside the settlement transaction.
- **Limit-order bounties.** Sponsors lock UNB to commission routes for unmapped sites or intents.
- **Permanent supply sink.** Every passed fetch sends 5% of its fee to buy and burn UNB, supplemented by early-launch snipe taxes and forfeited domain-challenge deposits.

UNB carries no governance vote, confers no protocol privileges, and pays zero yield when held passively in a wallet. Earning USDC requires backing specific routes that real callers verify and pay for.

## 7. Route coins and bonding curves

Every content-addressed entry can deploy at most one coin: an ownerless OpenZeppelin ERC-20 clone at a deterministic `CREATE2` address derived from the entry's byte hash, with a fixed supply of 1,000,000,000 coins. Identical copies map to the same entry and cannot open duplicate coins; modified recipes get fresh hashes and compete on their own curves.

Listing a route is free and deploys no token. A coin launches in one atomic transaction only when its launcher (either the credited lister or a releasing bounty) pays gas and executes the opening purchase, ensuring no coin exists without real UNB committed behind it (whether the node offers a default opening buy size for listers remains open).

Upon launch, the whole supply is placed on an ownerless constant-product bonding curve adapted from Clank's launch contracts, paired against a virtual reserve of 30,000,000 UNB that governs price slope (calibrating whether a shallower virtual reserve better rewards early discovery is open). Because marginal price rises as coins leave the curve, early builders and verifiers acquire stake more cheaply than latecomers. Every buy and sell on the curve pays 1% in UNB to the platform. To deter automated snipers in the opening blocks, buys within 5 minutes of launch pay an extra tax decaying linearly from 50% to zero into the burn buffer, with the atomic launch buy exempt.

Route coins have no expiry date; holders can sell back into the curve's real UNB reserve at any time. The curve is the coin's permanent market: nothing is held back, the price rises without bound toward the last coin, so a buy can never exhaust it, and a coin never moves to a pool (`decide.no-graduation`).

## 8. How one rule handles early discovery and mature yield

Instead of splitting route revenue arbitrarily between an author royalty and a verifier pool, Unbrowse applies a single ownership rule to the route's 65% share (`r`). Every coin in the fixed 1,000,000,000 supply holds an equal claim on `r`. Let `σ` denote the fraction of total supply staked prior to the current epoch by wallets that have verified the entry:

- **Prior verified stakers receive `σ · r` in liquid USDC**, distributed pro rata via an `O(1)` running sum.
- **The remaining `(1 - σ) · r` swaps from USDC into UNB**, buys the entry's coin on its curve, and stakes those newly bought coins immediately for the caller.

Notice how naturally this shifts across a route's lifecycle. When a route first launches, `σ` is close to zero: nearly the entire 65% of each early fetch buys coins off the curve, pushing up the coin's price to reward the lister sitting at the bottom of the curve while turning early adopters into staked holders. As dozens of callers adopt the route and keep their bought coins staked, `σ` climbs; a larger fraction of each subsequent fetch pays out directly in USDC cash flow, while a smaller fraction buys increasingly scarce coins. In our bounded Quint simulation, stakers received roughly 3% of the route share in USDC when 3% of supply was staked, rising to 45% when 45% was staked (Appendix B).

Because newly staked coins start earning only in the next epoch, a caller never pays itself from its own fetch. Each fetch swap also buys UNB from the public pool: across 100 simulated fetches in a bounded pool, UNB's price rose 13%, meaning higher UNB valuations cause a fixed dollar fee to purchase fewer route coins.

## 9. Staking, checks and exit delays

Holding unstaked coins earns nothing; holders stake coins in the entry's staking contract to earn USDC from the next epoch onward. To tie yield to actual route utility rather than blind speculation, staked coins earn only once their wallet has **checked** the entry: either by paying the listed price for a passed fetch served by another identity, or by serving a passed fetch paid by another identity. Self-payments within one identity never register as a check. Once earned, a wallet's check never expires on a clock, sparing satisfied users with cached recipes from paying for artificial repeat checks.

When staking (including automatic stakes created by a fetch), the holder specifies an **exit delay** (24 hours by default). Requesting an unstake starts that timer, during which the coins earn nothing before returning to the wallet; longer exit delays receive higher collateral weight in route ranking (the exact scaling curve remains open). Accrued USDC is claimed at the holder's convenience against epoch Merkle roots, avoiding any on-chain loop over holders. Nothing withholds payouts into a compulsory bond, and no court or vote can slash staked coins; a holder's sole risk is market price and route obsolescence.

## 10. Bounties as limit orders

When an agent needs a site nobody has mapped yet, waiting for spontaneous discovery may be too slow. Any wallet can post UNB into the bounty contract for a target site or intent, while callers using existing routes pay nothing into bounties.

Every bounty acts as a **limit order** naming the highest price per coin (fees and snipe tax included) the sponsor will accept. If someone tries to front-run an open bounty by launching a coin early and buying up its curve, the bounty refuses to fill above the sponsor's cap, leaving the front-runner out round-trip trade fees while returning unfilled UNB to the sponsor.

Bounties settle without human judges via two paths:

1. **Sponsor confirmation.** After paying for and passing a real call on a candidate entry, the sponsor confirms the entry. The bounty launches the coin (or buys at market up to its limit) and splits the purchased coins 50% to the credited lister and half to the sponsor, both staked and verified. Builders can therefore earn substantial early stake with $0 upfront capital.
2. **Proportional release by organic use.** Every counting paid fetch on the site after the bounty was posted automatically releases bounty UNB in proportion to USDC paid, capped at 5% of that USDC. Capping automatic release at the exact 5% burn share guarantees that even an attacker who owns both the target website (30%) and 100% of the route's stake (65%) loses at least as much to the irreversible burn as it could ever unlock from a stranger's bounty. Unused UNB returns to the sponsor after expiry.

## 11. Supply, allocation and locks

UNB has a fixed supply of 1,000,000,000 UNB (18 decimals), minted once at genesis on Arc mainnet. The token contract has no mint capability, so post-launch issuance is 0 UNB and every burn permanently reduces supply.

| Holder | Share | Terms |
|---|---|---|
| Public launch pool | 67% | Open market in UNB's existing public pool on Arc (proposed share) |
| Rewards reserve | 10% | Locked in utility contract; funds hourly listing roots only, never bounties or yield |
| Treasury (tranche 1) | 5% | Cliff-locked 3 months from genesis |
| Treasury (tranche 2) | 10% | Cliff-locked 6 months from genesis |
| Team (including investors) | 8% | Cliff-locked 3 months from genesis |
| Airdrop | 0% | None (discretionary airdrops rejected to prevent self-dealing) |

Locked tranches release nothing before their cliff month and unlock by elapsed time alone, independent of volume or token price. The rewards reserve never stakes, matches fees or funds bounties; its remaining scope beyond posting hourly listing roots is open.

## 12. Unbrowse's own holdings and disclosures

The team intends to purchase up to 7% of supply on the open market at launch from publicly disclosed wallets; those tokens are accounted for as insider holdings, never presented as organic demand. Unbrowse posts bounties from its own UNB under the same contract rules as any outside sponsor. Because bounty confirmation stakes half of the purchased route coins for the sponsor, early founder bounties may make Unbrowse a substantial disclosed staker across initial routes (whether bounties draw from the team line and how positions are reported are open details finalized before opening). Until independent contributors overtake initial route listings, the founder remains the network's primary operational trust point.

## 13. Summary of value flows and UNB demand

| Flow | Source | Destination |
|---|---|---|
| Route share (65%) | Passed fetch fee (USDC) | Verified prior stakers in USDC + swap to UNB to buy & stake coin for caller |
| Website share (30%) | Passed fetch fee (USDC) | Target domain's on-chain USDC escrow |
| Fee burn (5%) | Passed fetch fee (USDC) | Batch-swapped once per epoch for UNB and burned |
| Launch snipe tax (up to 50%) | Coin buys in first 5 minutes | Burned in UNB |
| Curve trade fee (1%) | Every route-coin curve buy/sell | Paid in UNB to the platform |
| UNB pool fee (4%) | Swaps in UNB's public pool | Paid once per swap (4% pool fee) to Unbrowse to fund company operations |

The 5% burn acts as an automated fee-funded buyback and is disclosed plainly as one rather than as a price floor. Across the entire protocol, four mechanisms create demand for or remove UNB: automatic coin buys on paid fetches, UNB locked in open bounties, permanent burns, and voluntary purchases by traders and verifiers staking for rank and USDC yield. Every single one scales with real paid adoption; without callers paying for routes, all four go quiet. Whether an additional slice of route fees should accrue directly to UNB beyond the 5% burn remains an open question.

## 14. Economic risks and open questions

- **Market volatility:** Neither UNB nor any route coin carries a price floor or promised yield; broken or superseded routes lose traffic and token value.
- **Accepted capital trade-offs:** Because rank uses no identity weights, locking large capital can outrank a smaller route (though failed fetches cost callers nothing and yield $0 to the holder); a heavily capitalised modified copy (about 30× the original lister's stake in our model) can narrowly out-earn backing the original curve, accepted as open competition because copies and fixes are indistinguishable on chain; dormant holders who neither call nor sell slow a broken route's decay; and insiders spotting a site break early can sell first.
- **Simulation vs live evidence:** Current route-coin evidence comes from coarse Quint simulations; earlier whole-web Monte Carlo runs predating the 10 November rules showed lower coverage and negative average investor returns in passive scenarios, making pilot measurement essential.
- **Audit, legal and open parameters:** UNB launched prior to contract audit and legal review, which remain strict gates before opening the network. Counsel must evaluate securities treatment of staked route-coin payouts. Open design items include default node miss-bounties, exact site-matching rules for bounties, excluding self-paid wash calls from staker payouts, optional agentic coin top-ups after successful runs, and co-founder review of the fee split and constitutional rank update.

---

## Appendix A. Step-by-step lifecycle of a paid fetch

Suppose an entry's coin is live, a fraction `σ` of its 1,000,000,000 fixed supply was staked prior to the current epoch by verified wallets, and a new caller executes a fetch of price `p` USDC that passes its mechanical check:

1. **Three-way split:** Settlement allocates 30% of `p` to the target domain's escrow, 5% to the epoch burn buffer, and `r =` 65% of `p` to the route.
2. **Cash yield to prior stakers:** `σ · r` USDC credits pro rata to those pre-existing verified stakes via a global accumulator, claimable at will.
3. **Market buy for the caller:** `(1 - σ) · r` USDC swaps into UNB through UNB's public pool (paying the pool's 4% fee once) and buys the entry's coin on its curve.
4. **Immediate verified stake:** The purchased coins lock in the staking contract for the caller under its default 24 hours exit delay. Because the caller just passed a counterparty fetch, its wallet is marked verified, its coins enter `Q` immediately, and they begin earning USDC from the next epoch.
5. **Free local reuse:** The caller caches the recipe bytes and runs subsequent calls against the website at $0. (If the entry had not launched a coin yet, steps 2–4 simplify to crediting `r` USDC directly to the credited lister.)

## Appendix B. Bounded Quint simulation results

Source: `coins.qnt` (`coins_current`, Quint 0.33.1; ancillary in `arxiv/anc/`). Coarse integer scale (1 coin unit = 1,000 coins; 1 UNB unit = 10,000 UNB; 1:1 initial UNB/USDC pool; 65%/30%/5% split). Twenty state invariants held across 10 modules over 2,000 20-step random traces.

| Fetches completed (1/day) | 1 | 4 | 16 | 48 |
|---|---|---|---|---|
| Share of fixed supply staked (`σ`) | 2% | 8% | 23% | 42% |
| Next fetch (route share 65) paid to stakers in USDC | 1 | 5 | 15 | 27 |
| Coin units bought & staked for next caller | 19,072 | 15,959 | 9,127 | 3,854 |

| Scenario (`coins_current`) | Outcome in model units |
|---|---|
| Ten-line fetch when only lister is staked | Lister receives `63` of `650` USDC and caller `0`; next fetch pays that caller `90` (`165` cumulative) |
| Ten failed lines on a broken route | Stakers earn `0`; caller pays `0` |
| Washer with 10% supply staked wash-pays `10,000` USDC | Recovers `695` USDC + `5,360` coin value; loses `3,945` net to site escrow, burn and slippage |
| 100 paid lines (`6,500` into `100,000` UNB pool) | UNB price rises 13%; at 2.25× UNB price, identical fetches buy 30% fewer coins |
| Lister front-runs a `3,000` bounty | Uncapped: nets `2,337`; with 2× limit price: `0` fills and front-runner loses `14` in fees |
| Three additional callers fetch a working route | Rank rises 9–11% per fetch; lister's stake value grows from `303` to `337` |

## Appendix C. Machine-checked proofs

Lean 4 theorems in `formal/` verifying conserved properties (`Unb.split_conserves` proves exact fee conservation on the `65 / 30 / 0 / 0 / 5` split with remainder to burn; `UnbLaunch.free_failure_costs_nothing` proves a failed line costs its payer nothing and pays nobody, whatever share of lines fail; and `UnbVerify.self_paid_never_counts` and `UnbVerify.unchecked_earns_nothing` prove no self-verification and zero payout without a counterparty check; the route-coin curve and staking contracts themselves await formal proof).

## Appendix D. Normative specification mapping

- **§2–§5:** `arc.usdc`, `R1.29`, `R3.10`, `R3.12`, `R3.30`–`R3.33`, `execute.none`, `skills.none`, `assume.pay-once`, `assume.demand-is-adoption`, `R4.1`–`R4.8`, `R4.13`–`R4.19`, `decide.failed-fetch-always-free`, `R4.26`–`R4.29`, `attack.fail-keep-body`, `coin.fetch-buys`, `coin.check`, `R4.32`, `R10.4`, `R10.5`, `decide.one-part-to-stake`, `deploy.new`, `decide.dnssec-only`, `decide.failed-fetch-always-free`.
- **§6–§10:** `arc.unb`, `coin.per-entry`, `build.oz-erc20`, `build.clank`, `coin.launch`, `coin.curve`, `coin.snipe-tax`, `coin.no-expiry`, `decide.no-graduation`, `coin.split`, `coin.holders-share`, `coin.fetch-pays`, `coin.fetch-buys`, `coin.fetch-stakes`, `coin.stake`, `coin.check`, `coin.claims`, `rank.exit-delay`, `bond.none`, `fraud.none`, `assume.self-pay-never-counts`, `coin.bounty-launch`, `coin.bounty-limit`, `coin.bounty-confirm`, `coin.bounty-by-use`, `coin.bounty-no-slicing`, `decide.early-cheaper`, `decide.split-by-stake`, `decide.coins-keep-91`, `decide.miss-pledges`, `decide.bounty-cap-five`, `open.curve-depth`, `open.exit-delay-scale`.
- **§11–§14:** `R8.12`, `R9.1`–`R9.30`, `R10.2`, `R10.9`, `R10.14`, `R11.8`, `R11.13`, `decide.capital-copy-accepted`, `attack.capital-copy`, `attack.insider-exit`, `quint.coins-rc`, `open.treasury-staker`, `open.team-line-bounties`, `open.coin-unb-capture`, `open.coins-evidence`, `open.counsel`, `open.coin-miss-bounty`, `open.coin-bounty-site`, `open.coin-wash-calls`, `open.use-to-own`, `open.pilot-coins`, `open.steefpls-review`.

*This paper describes an unlaunched network design and parameters that may change. Nothing here is an offer of any token or a promise of any return.*
