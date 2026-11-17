# Keeping the Map True: Rank, Checks and Serving

**Lewis Tham** · Unbrowse · lewis@unbrowse.ai · 11 November 2026 · *Protocol design, not yet open. UNB is live on Arc mainnet; the route-coin contracts ship as a new deployment after review, audit and the closed pilot. Numbers come from `protocol/params.toml`, governed by the Unbrowse design graph. Companion to "On Indexing the Entire Internet's APIs for Agents".*

> **UNB in brief.** Agents pay to fetch routes in dollars (USDC), never in UNB, at prices each route's lister sets. UNB is live on Arc mainnet with a fixed supply of 1,000,000,000 UNB, minted once at genesis with 0 UNB minted afterward. Every distinct route recipe can launch its own fixed-supply coin on a curve against UNB, pricing both the stake behind a route and the rank clients use to choose it. When a paid fetch passes, the route's 65% share pays existing verified stakers in USDC and swaps the remainder into UNB to buy and stake that route's coin for the caller, while 5% buys UNB and burns it. Anyone needing an unmapped site can post a UNB bounty as a limit order. Unbrowse's team (8%) and treasury (5% and 10%) are cliff-locked 3 months and 6 months, with no airdrop. UNB carries no vote, pays nothing for passive holding, and can fall in value; nothing here promises a return.

## Abstract

A shared directory of websites' internal APIs stays useful only while its routes return valid answers, yet sites change endpoints and schemas without warning. This companion paper explains how Unbrowse clients choose among competing recipes for the same task and replace broken ones without human raters, timers or fraud courts. Each distinct recipe body has its own coin traded against UNB, and every passed fetch buys and stakes that coin for the caller. Clients rank candidates by `S = √(Q · M)`, pairing the conservatively valued stake of verified callers whose own latest paid call passed (`Q`) with the coin's time-weighted market cap (`M`). When a site changes, failing fetches automatically disqualify callers' stake from `Q` while zero fee income pushes holders out of `M`, allowing a newly learned recipe with its own coin to overtake the broken one as callers fetch it. Content-addressed bodies let any peer seed recipes safely without bonds or serving fees, and local vault placeholders keep credentials out of recipes by construction.

## 1. Introduction

Several contributors may publish competing recipes for the same website action, and a recipe that worked yesterday can fail silently today by returning `200 OK` around an empty list or login wall. Every client therefore faces a selection problem: given signed listings for an intent, which byte-exact entry should it fetch and run?

Earlier iterations of Unbrowse tried to answer that question with familiar web and crypto tools: user ratings, statistical pass-rate switches, dedicated repair pools, and slashable fraud courts. One by one, simulation and design review exposed why each struggled. Paid raters earned more by rubber-stamping "pass" than by inspecting payloads; statistical pass rates required complex Sybil link-analysis over cheap wallets; repair pools created governance fights over what counted as a "fix"; and fraud courts needed subjective jurors. The current design strips away all four by relying on the one party whose incentives are naturally aligned with truth: the paying caller whose agent actually needs the data.

Section 2 examines what signals exist on chain when callers cache working routes locally; Sections 3 to 6 construct the check, collateral valuation, market cap and proportional pick; Sections 7 to 9 cover turnover after site breaks, peer-to-peer seeding and credential safety; Sections 10 and 11 analyse adversarial strategies and the three explicit trade-offs of identity-free collateral ranking; and Section 12 lists open questions.

## 2. What the chain can and cannot observe

Understanding Unbrowse's ranking formula starts with noticing what a blockchain *cannot* see. Once an agent pays to fetch a working route body, its node caches those bytes on disk and calls the website directly for free on every later task. Repeat daily successes leave zero on-chain footprint. Likewise, failed fetches pay nobody, meaning a route's decline often shows up first as paid passed fetches drying up alongside occasional failed refetches.

Any selection rule that pretended the contract could count real-time HTTP pass rates across cached calls would be resting on an illusion. Instead, clients observe three tamper-evident on-chain facts:

1. **Who verified an entry** via a real counterparty fetch, and whether their latest paid call passed or failed.
2. **How many coins sit staked** behind the entry, and what exit delay each staker committed to.
3. **What price the entry's coin commands** over time on its bonding curve or liquidity pool against UNB.

Because every passed fetch automatically buys and stakes the entry's coin for its caller, paid adoption continuously feeds all three signals without asking users to take a separate voting or rating step.

## 3. Mechanical checks and one-time verification

No human or external oracle grades responses. On every call, the caller's own client validates the HTTP response in code before signing pass or fail into its payment voucher: the status code must match the route's success set, the final URL must stay on a host bound to the target site (blocking silent redirects to login or captcha pages), the JSON body must validate strictly against the declared schema with at least one non-null result field, and signed-in or state-changing calls must match a structural path-and-type hash. A node may also let its local model reject semantically irrelevant payloads; the model can only turn a mechanical pass into a fail.

A wallet becomes **checked** (verified) on an entry the first time it either pays at least the listed price (and at least $0.000001) for a passed fetch served by a different identity, or serves a claimed passed fetch paid by a different identity. Payments between wallets sharing an identity never count as a check.

Importantly, a wallet's check never expires on a clock. In an earlier draft, stakers had to re-pay to check a route every few days to keep earning; because nodes cache working recipes locally for free, that timer would have forced honest users to waste money on synthetic traffic. Under route coins, you verify once through real use, and staleness surfaces naturally when callers fail refetches or holders sell unproductive stake.

## 4. Counted stake and automatic disqualification

Only verified, actively working stake enters an entry's collateral score `Q`. Specifically, a coin counts toward `Q` if and only if three conditions hold:

1. It is locked in the entry's staking contract.
2. Its wallet has checked the entry via a real counterparty call.
3. **That wallet's own latest paid call on the entry passed.**

The third clause makes failure reporting self-enforcing. When a site changes and a user's paid fetch (either a newcomer's first try or a prior user's refetch after its local cache broke) fails the mechanical check, the caller's client marks its own voucher line failed, which costs it nothing. Recording that line automatically suspends the wallet's staked coins from `Q` until a subsequent paid call passes. No bounty hunter has to submit an accusation, and a rival submitting fake failures can only remove *its own* stake from `Q`, never anyone else's.

Because callers run cached recipes off chain until something breaks, the latest-call rule observes failures only when a paid fetch occurs; whether to keep the clause or rely solely on unpaid holders selling remains an open question for the pilot.

## 5. Valuing collateral conservatively

Counting raw coin quantities would let an attacker mint or buy cheap tokens on an empty curve and claim massive backing. Every counted stake is therefore valued in UNB under three conservative rules designed to measure what an attacker truly has at risk:

- **Lower of time-weighted price and spot liquidation (`TWAP` cap).** Each stake is priced at the minimum of the coin's 24 hours time-weighted average price in UNB and what selling those coins into the curve right now would return. A brief one-block spike adds nothing.
- **Last-out liquidation ordering.** Spot liquidation value is calculated as if *every unstaked coin in circulation* were sold back to the curve first, leaving staked coins to redeem against whatever reserve remains at the bottom. Speculators who buy coins without staking them sit first in the exit line and contribute zero collateral to `Q`.
- **Commitment-scaled exit delay.** When staking, a wallet names how long the contract must hold its coins after an unstake request (24 hours by default), earning nothing during cooldown. Stake counts immediately in proportion to that chosen delay (modelled as `delay / (delay + 1 day)`, with exact scaling open), rewarding capital committed to stay through real tests without imposing a multi-day blind warm-up on fresh fixes.

Summing these conservative UNB values across all counted stakes yields `Q`. Because `Q` is strictly linear in staked coins, splitting a position across a hundred Sybil wallets yields the exact same `Q` as holding it in one wallet.

## 6. Combining collateral and market cap in the pick

An entry's overall rank is the geometric mean of its counted collateral and its market cap:

`S = √(Q · M)`

where `M` equals the coin's fixed 1,000,000,000 total supply multiplied by its 24 hours time-weighted price in UNB (evaluating price across fixed total supply ensures `M` tracks price monotonically; multiplying circulating supply by marginal price on a constant-product curve would stay artificially flat or move perversely as coins are bought).

Why multiply `Q` and `M` rather than using either alone? Because each guards the other's blind spot:

- Without `Q`, an unverified coin pumped by unstaked traders with zero passing calls would attract traffic (`Q = 0` forces `S = 0`).
- Without `M`, a broken route whose old stakers went offline and stopped calling would ignore live market exits (`M` drops immediately as informed holders sell).

Nothing else enters `S`: no per-identity spending weight, no historical payout multiplier, and no decay clock. Clients select among budget-fitting candidates in proportion to `S`, while reserving 5% of public read-only picks for unverified entries below 30 counted uses so better newcomers can prove themselves risk-free. To stop a brand-new wallet from absorbing an entire site's paid traffic overnight, clients also respect a per-wallet daily fee capacity of $2.00 plus 20% of cumulative clean fees earned. Historical Bayesian pass rates remain visible to clients for diagnostics and no longer drive selection; older clients that still pick by pass rate remain safe and simply choose differently for their own owners. When a chosen entry fails, the client falls back down the ranked list and opens its local browser only if every candidate fails.

## 7. Natural selection when websites break

Unbrowse never repairs routes in place. When a website changes its backend schema, turnover happens organically across two separate coins:

First, callers hitting errors trigger failed refetches that strip their stake from the old entry's `Q` before anyone sells a coin, while $0 fee payouts prompt active holders to unstake and sell, pulling down `M`. Second, the first node whose fallbacks all miss walks the live page in its browser, learns the updated request, and lists the new byte hash with its own coin. Every caller that fetches this working replacement automatically buys and stakes its coin; because their calls pass, every bought coin counts immediately in `Q`.

In our bounded Quint simulation, four callers failing on a broken route (`300` lister units) immediately knocked 22% off its rank with zero sales, and a replacement launched at `30` units (one-tenth of the broken lister's stake) overtook the broken entry on its sixth user fetch (Appendix A). When automatic staking of fetched coins was switched off, the replacement stalled after its first fetch: callers becoming verified stakers is what powers natural selection.

## 8. Peer-to-peer serving, liveness and eclipse defence

Listings and recipe bodies live on the nodes that use them rather than on central servers. Providers advertise signed domain listings in a Kademlia hash table under `/unbrowse/site/<domain>`; a seeker queries at least 2 distinct ERC-8004 identities, verifies Merkle root inclusion, and computes `S` locally. To block Sybil eclipse attacks around popular domains, routing admission requires the leading 16 bits of each peer's hash-table ID to match a digest of its paid on-chain identity registration and block hash, making targeted positioning require roughly `2^16` paid registrations.

Any node that paid for a recipe body seeds it by default while cached, keeping routes reachable when their original lister goes offline. Because clients verify every served byte against the signed listing's hash before paying or running anything, a seeder cannot corrupt a recipe. Seeders therefore post no bond and take 0% of fetch fees, seeding naturally as peers and earning through any stake they hold. Providers serving mismatches or timing out are dropped locally, and entries with zero answering providers in an epoch step off rankings on a doubling backoff (`1, 2, 4, …` up to 32 epochs) with zero stake forfeiture, since network silence cannot be proved malicious.

## 9. Credentials and host boundaries

Security for user sessions rests on deterministic client invariants rather than post-hoc punishment:

- **Secrets never enter recipes.** Vault credentials become local placeholder inputs filled only at call time; the compiler strips cookies and auth headers; a pinned detector blocks publication of any unsourced credential-like string; and every fetching client scans incoming bytes and refuses to run, cache, seed or pay for anything flagged.
- **Strict host binding.** To stop a malicious listing under `site-a.com` from tricking a caller's node into sending `site-a.com` cookies to `evil.com`, clients send requests only to hosts bound to the target site: (a) the same registrable domain under the Public Suffix List, (b) hosts explicitly declared in the site's verified on-chain policy, Related Website Sets or exact `Content-Security-Policy` `connect-src` directives, or (c) hosts observed receiving first-party script calls in the client's own browser (third-party ad or analytics scripts never bind signed-in credentials).

## 10. Adversarial analysis

With no fraud court or slashing, security relies on making each attack either unprofitable or self-limiting:

| Strategy | Protocol response and cost to attacker | Outcome |
|---|---|---|
| **Self-paid wash volume** | Never registers as a check; loses 30% site escrow + 5% burn + pool slippage on every cycle | Strictly worse than buying & staking openly |
| **Sybil stake splitting** | `Q` is linear in staked value with no per-identity multiplier | Zero extra rank |
| **Rival wash dilution** | Identity weights were removed after 900 rival washes cut honest rank 95% in a 10-node model | Zero effect on honest routes |
| **Unstaked pump-and-dump** | Last-out math gives unstaked coins zero `Q`; lifts `M` only while held (+88% for 1 day in model at round-trip fee cost) | Temporary and fee-negative |
| **Single-block price spike** | Valued at `min(TWAP, spot last-out sale)` | Zero collateral gain |
| **Fake failure spam on rival** | Disqualifies only the caller's own stake | Harms only the sender |
| **Bounty launch front-run** | Sponsor's limit price refuses overpriced curve fills | Zero fill above cap; attacker pays curve fees |
| **1-byte near copy** | Hashes to an empty curve with `Q = 0, M = 0`; overtakes only with real capital or adoption | Priced by capital |

## 11. Costs the design accepts

Choosing linear, identity-free collateral without slashable bonds, and free failures, entails four honest trade-offs:

1. **Locked capital can buy rank.** Once a wallet checks an entry, staking ten times an incumbent's collateral outranked it roughly six-to-one in simulation. Because failed calls are free for callers and pay $0 to stakers, buying rank on a broken route steals no fees from callers and leaves the whale paying curve fees upon exit; capital buys attention, not guaranteed income.
2. **A heavily capitalised copy can out-earn backing the original.** Launching a modified working copy starts at the bottom of a fresh curve, whereas buying into an established entry climbs its curve. Up to ten times the original lister's stake in our model, backing the original earned more; at thirty times, copying earned about 5% more and left the first lister about a tenth of its income. Callers still get a working route, and because a copy and a post-break fix are both simply new hashes with new coins, outlawing one would outlaw permissionless replacement.
3. **Dormant holders slow a broken route's decay.** A staker who neither submits a failing paid call nor sells keeps its portion of `Q` and `M` standing after a break; active callers strip their own stake immediately and zero yield nudges rational holders out, though no clock forces silent wallets to exit. Insiders spotting a site break early can likewise sell before public callers fail, accelerating price discovery on dying routes.
4. **A payer can sign every fetch failed.** Its own client signs pass or fail and failures are always free, so it gets every answer unpaid and keeps the body. Nothing on chain bounds this; a server may stop serving such a payer on its own judgment. The lie does cost the payer the coin: an unpaid fetch buys none, and a wallet that has never passed a paid call has checked nothing, so coin it buys on the curve earns nothing and stays out of `Q`. A caller that wants to hold a route pays for its fetch, which leaves the gain to callers that want the answer and no stake, at one fee per route version.

## 12. What stays open

Before mainnet deployment, the pilot and engineering review must settle several open questions: whether to keep the latest-paid-call disqualification clause given off-chain caching; the exact function mapping exit delay to `Q`; whether the 24 hours averaging window goes shorter; virtual curve depth (30,000,000 UNB); what role the legacy Bayesian pass-rate switch retains now that `S` drives picks; how to detect degraded signed-in routes that third parties cannot replay; whether cryptographic proofs of equivocation should delist entries without slashing; and constitutional sign-off on stake-weighted selection. Separately, scoped version endorsements (where stake vouches for a specific version after personal use) remain under evaluation in Quint as an experimental comparison rather than part of the chosen design.

---

## Appendix A. Bounded Quint simulation results

Source: `coins.qnt` (`coins_current`, Quint 0.33.1; ancillary in `arxiv/anc/`). Coarse integer scale (`1,000,000` coin units, `3,000` virtual UNB reserve units, 1:1 opening UNB/USDC pool, delay weight `d / (d + 1 day)`, rank in thousandths of a UNB unit). Twenty invariants held across 10 modules over 2,000 20-step traces.

| Simulated scenario (`coins_current`) | Model outcome |
|---|---|
| Three additional callers fetch a working route | Rank climbs 9–11% per fetch (`845,985` to `1,117,598`) |
| Quiet working route over 1–3 days | Rank stays flat (no artificial decay clock) |
| Route breaks; 4 callers fail fetches; nobody sells | Rank drops 22% immediately (`1,117,598` to `868,191`) |
| Replacement launched at `30` (vs `300` lister) fetched by users | Climbs `0 → 385,748 → 513,435 → 624,034 → 725,730` (4 fetches), overtaking on 6th fetch (`915,074`) |
| Identical break with fetched coins left unstaked | Broken route drops 8%; replacement stalls at `215,480` (1 fetch) and `228,651` (4 fetches) |
| Same stake with 1-hour, 1-day, 1-week exit delay | Rank `411,719`, `845,985`, `1,061,496` |
| 100 wash lines (`10,000` USDC) vs open curve buy (`6,500` UNB) | Wash ranks 8% lower (`5,965` vs `6,369` coin value) |
| 900 rival wash lines in a 10-route network | 0% impact (vs −95% when identity weights were active) |
| Whale stakes `3,000` (10× lister) on rival route | Outranks ~6:1; earns `0` when broken and redeems `3,000` for `2,986` |

**Copying vs backing (`pick_report`, 160 lines over 16 days against `300` lister stake, net USDC gain over idle UNB):**

| Challenger capital | Copying | Backing | Lister (copied) | Lister (backed) | Copy's share of 160 lines |
|---|---|---|---|---|---|
| none | | | 2,497 | 2,497 | 0 |
| 30 | 364 | 692 | 1,792 | 2,509 | 49 |
| 300 | 1,322 | 2,284 | 1,538 | 2,550 | 66 |
| 1,000 | 3,589 | 4,613 | 1,053 | 2,667 | 97 |
| 10,000 | 8,323 | 7,942 | 260 | 5,679 | 145 |

Over 48 days at `3,000` capital (10× lister), backing netted `20,382` vs `18,183` for copying.

## Appendix B. Machine-checked proofs

Lean 4 theorems in `formal/` verifying conserved check and failure rules (rank and curve contracts await formal proof): `UnbVerify.self_paid_never_counts`, `UnbVerify.serving_counts_as_check`, `UnbVerify.unchecked_earns_nothing`, and `UnbLaunch.free_failure_costs_nothing`.

## Appendix C. Why raters, repair pools and fraud courts were retired

Paid caller ratings (`R3.21`), pass-rate default switches (`rank.pick`), in-place repair bounties (`route.replace`), and slashable fraud courts (`fraud.none`) were each modelled and retired in turn because every one required paying or trusting third-party reporters and judges. Ranking by `√(Q · M)` over byte-hashed route coins relies solely on actions participants already take in their own interest: paying once for working routes, marking broken fetches failed to save fees, staking to earn USDC, and selling unproductive coins.

## Appendix D. Normative specification mapping

- **§2–§6:** `assume.pay-once`, `assume.failed-lines-free`, `assume.pass-rate-off-chain`, `assume.self-pay-never-counts`, `assume.check-once`, `R3.4`, `R3.12`, `R3.17`–`R3.21`, `R4.33`, `R5.16`–`R5.22`, `R6.12`, `R6.13`, `coin.check`, `coin.stake`, `coin.fetch-buys`, `coin.fetch-stakes`, `rank.counted-stake`, `rank.collateral`, `rank.twap-cap`, `rank.last-out`, `rank.exit-delay`, `rank.score`, `rank.pick`, `decide.coins-keep-91`, `decide.rank-cap-no-clock`, `decide.users-stake-no-weight`.
- **§7–§9:** `route.replace`, `decide.no-repairs`, `decide.rank-collateral`, `decide.fetch-buys`, `assume.relearn`, `assume.hosts-recent-users`, `R7.1`, `R7.3`, `R7.6`, `R7.12`–`R7.26`, `R7.34`, `decide.no-server-bond`, `decide.seeding-natural`, `decide.one-part-to-stake`, `credential.never`, `decide.no-credential-leak`, `R2.27`–`R2.29`.
- **§10–§12:** `fraud.none`, `coin.fetch-pays`, `coin.bounty-limit`, `attack.bounty-front-run`, `attack.near-copy-coin`, `attack.insider-exit`, `attack.capital-copy`, `attack.coin-bought-rank`, `attack.stayer`, `decide.capital-copy-accepted`, `decide.scoped-endorsement-trial`, `quint.coins-rc`, `open.latest-call-rule`, `open.exit-delay-scale`, `open.rank-window`, `open.curve-depth`, `open.coin-switch-test`, `open.signed-in-route`, `decide.failed-fetch-always-free`, `open.coin-fraud`, `open.steefpls-review`.

*This paper describes an unlaunched network design and parameters that may change. Nothing here is an offer of any token or a promise of any return.*
