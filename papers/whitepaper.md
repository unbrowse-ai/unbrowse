# On Indexing the Entire Internet's APIs for Agents

**Lewis Tham** · Unbrowse · lewis@unbrowse.ai · 11 November 2026 · *Protocol design, not yet open. UNB is live on Arc mainnet; the route-coin contracts ship as a new deployment after review, audit and the closed pilot. Numbers come from `protocol/params.toml`, governed by the Unbrowse design graph.*

> **UNB in brief.** Agents pay to fetch routes in dollars (USDC), never in UNB, at prices each route's lister sets. UNB is live on Arc mainnet with a fixed supply of 1,000,000,000 UNB, minted once at genesis with 0 UNB minted afterward. Every distinct route recipe can launch its own fixed-supply coin on a curve against UNB, pricing both the stake behind a route and the rank clients use to choose it. When a paid fetch passes, the route's 65% share pays existing verified stakers in USDC and swaps the remainder into UNB to buy and stake that route's coin for the caller, while 5% buys UNB and burns it. Anyone needing an unmapped site can post a UNB bounty as a limit order. Unbrowse's team (8%) and treasury (5% and 10%) are cliff-locked 3 months and 6 months, with no airdrop. UNB carries no vote, pays nothing for passive holding, and can fall in value; nothing here promises a return.

## Abstract

Every interactive website already runs an API for its own front end. Software agents that call those internal endpoints directly avoid the latency and model cost of driving a browser, yet a shared directory of endpoints faces a commons dilemma: sites change without warning, broken entries linger, and whoever verifies or replaces an endpoint pays a private cost for a public benefit. We present Unbrowse, a peer-to-peer protocol in which ordinary paid use maintains the map without human raters, timers or dispute courts. Agents learn HTTP recipes from their owners' normal browsing, strip credentials into local vault placeholders, and publish content-addressed listings for free. Callers pay once per recipe version in USDC, and every passed fetch automatically buys and stakes that recipe's coin for the caller. A wallet's stake counts toward rank only while its own latest paid call passed, and clients pick recipes in proportion to the geometric mean of verified staked collateral and time-weighted market cap. When a site changes, failing fetches immediately pull callers' stake out of the broken recipe's rank while an updated recipe launches a fresh coin that overtakes it as callers adopt the fix. Smart contracts on Arc enforce payments, curves and stakes; discovery, serving and selection run in each peer's client. Dropping identity weights eliminates Sybil games at the explicit cost that locked capital can buy rank, a trade-off we state alongside two related boundaries.

## 1. Introduction

Behind nearly every web page sits an interface built for machines. When a user searches or submits a form, page scripts send a structured HTTP request to the site's backend and render the JSON that comes back. An agent that knows how to form that request, which we call a **route**, talks to the site the way the site's own app does.

Most agents today do not know those routes, so they rent a virtual machine, launch a browser, wait for scripts, and pay a language model to read HTML. On WebArena, browser agents completed 14.41% of tasks against 78.24% for people [1]. Discovering a task cold in a browser cost a median of $0.126 in model inference in our tests, while replaying a learned route answered in 950 ms on average across 94 domains against 3,404 ms for browser automation [2] (Appendix A). Without Unbrowse, the agent discards how it reached the data and the next agent pays again.

Sharing learned routes turns discovery into a one-time cost per site version, leaving upkeep as the hard problem. Sites rename fields and move sign-in flows without notice, so a stale route often returns `200 OK` around empty or wrong data. Checking and replacing routes costs whoever does it while helping every later caller, so private payment under-supplies upkeep [3]; the index is a common-pool resource [4]. Putting a company in charge trades rot for enclosure: a central host sees every query, holds pricing leverage once builders depend on it, and creates one point of failure.

Ostrom showed that lasting commons make monitoring a side effect of ordinary use [4]. On the web, the first party to see whether a route still works is the caller running it. Unbrowse turns that fact into rules: each distinct route body gets its own coin traded against UNB, and every paid fetch buys and stakes that coin for the caller. Because stake counts toward rank only while its holder's latest paid call passed, callers verify the map by using it, and early backers earn only while real callers keep succeeding.

Section 2 defines the model and its assumptions, Sections 3 to 10 present one mechanism each, Section 11 explains what lives on chain versus in the client, Section 12 analyses attacks and accepted trade-offs, Section 13 reports our measurements and simulations, and Section 14 states the limits.

## 2. Model and assumptions

A **route** is a declarative recipe for one API request: domain, HTTP method, URL template, parameter schema, expected response shape, and required session type. An **entry** is one byte-exact body for that route, named by the cryptographic hash of its canonical bytes. Identical copies share the same hash and entry, while changing a single byte creates a new entry. A **listing** is a wallet-signed record offering an entry at a chosen price; whichever on-chain Merkle root commits to an entry's hash first establishes its credited lister.

Every participant runs the same open-source **node** locally beside their agent. Under one wallet and one ERC-8004 identity on Arc, a single node plays every role: **lister** when publishing routes, **payer** when fetching them, **server** when seeding cached bytes to peers, and **holder** when owning route coins. Websites earn their fee share without installing anything.

Four realities shape the design:

1. **Content addressing prevents tampering.** Clients check every served body against the listing's hash before paying or running it, so a server can deliver a recipe or stay silent, never alter it.
2. **Callers pay once per version.** A node caches each working body it fetches and calls the website directly for free after that. On-chain fees therefore measure new adoption and version turnover rather than daily call volume.
3. **Identities are cheap.** Registering an identity costs cents in gas, so any rule granting extra weight or quota per identity can be farmed across Sybil wallets [5].
4. **Peers upgrade voluntarily.** Old and modified clients stay online indefinitely. Rules that move money must live in immutable contracts; client rules hold only when following them helps the peer's own owner.

## 3. Learning and listing without leaking secrets

No crawler maps the web in advance. A node learns routes passively from its owner's browsing and from browser walks triggered when its agent misses on an unmapped site. As the page runs, the node traces each outgoing request value to its source (user input, earlier response, cookie, or a page script derivation re-evaluated in a sandbox) and compiles the graph deterministically into pure data.

Because useful routes often run behind a login, credential safety cannot wait for post-hoc slashing; a leaked secret causes harm at publication. Unbrowse prevents leaks by construction in the node. Secrets live in the owner's OS Keychain and enter recipes solely as vault placeholders filled locally at call time. During compilation, the node strips auth headers and cookies, turns account-bound values into parameters, drops response bodies, and re-verifies public routes without cookies. Before listing, a pinned detector scans the canonical bytes and refuses any credential-shaped string that lacked a public source during the walk; every fetcher runs the same scan and refuses to run, keep, seed or pay for a flagged body. Both sides follow the rule to protect their own sessions.

Listing costs zero gas and needs no bond. Nodes share learned routes by default once they pass across 3 days or 5 runs, unless marked private. Signed listings spread peer to peer and anchor in hourly Merkle roots posted by the rewards reserve (or immediately if a lister posts its own root). Each lister sets its USDC price down to $0.000001 with no suggested default, so equivalent routes compete prices down. Withdrawing a listing removes only that wallet's notice; peers keep seeding the bytes and the coin keeps trading.

## 4. Paying once in dollars

Pricing routes in a volatile token would force agent builders to hold speculative inventory just to use websites. Callers therefore deposit and sign EIP-712 vouchers strictly in USDC, which also pays gas on Arc. On a cache miss, a client sends a voucher to a serving peer, checks the body's hash, calls the website directly from its own machine, and caches the working recipe.

Payment follows a mechanical check in the caller's client rather than ratings: HTTP status, bound host, strict schema match, at least one non-null result field, and a structural shape hash on signed-in or state-changing calls (optionally tightened by the caller's local model). A failed fetch pays nobody and costs the caller nothing, however many of its fetches fail, so unfamiliar routes stay free to try. The contract keeps no failure count (Section 12 gives the cost).

Each passed line splits once in the settlement contract: 65% to the route, 30% to on-chain escrow for the website's domain, and 5% batch-swapped once per epoch into UNB and burned. Neither the server (0%) nor the platform (0%) takes a cut, leaving three clean flows. Domains accrue escrow automatically and claim it with a DNSSEC proof, paid after 14 epochs; sites opt out for free by disallowing `Unbrowse` in `robots.txt`.

## 5. One coin per route body

If one shared pool represented "the route for Site X", someone would have to judge which updated recipe deserves that slot when the site changes. Unbrowse avoids governance over route names by binding each coin to exact bytes: every entry can deploy at most one OpenZeppelin ERC-20 coin at an address derived from its hash, with a fixed supply of 1,000,000,000 coins and no owner, mint or pause. An exact copy shares the hash and cannot open a second coin; any modified recipe gets a new hash and competes on its own coin.

Listing deploys nothing on chain. A coin launches atomically with its first buy, funded by its credited lister or a bounty. At launch, the whole supply opens on an ownerless Clank-derived constant-product curve against UNB with a virtual reserve of 30,000,000 UNB. Price rises as coins are bought, rewarding early discovery, while trades pay 1% in UNB to the platform. Buys in the first 5 minutes pay an extra tax decaying from 50% to zero into the UNB burn (exempting the launch buy) so bots cannot snipe the bottom of a new curve. Coins never expire; holders exit anytime into the curve's real reserve. The curve is the coin's permanent market: nothing is held back and a coin never moves to a pool (`decide.no-graduation`).

## 6. A fetch pays prior stake, then buys

In standard creator markets, the uploader takes a permanent cut while buyers have no stake in whether the file works tomorrow. Unbrowse removes the lister cut: a lister earns purely as an early staker of its own coin.

One symmetric rule divides the route's 65% share across every coin in the fixed 1,000,000,000 supply:

- **Coins staked before the current epoch by verified wallets** earn their proportional fraction (`σ`) directly in USDC, claimed whenever the holder chooses.
- **The fraction belonging to all other coins** (`1 - σ`, whether unsold on the curve, unstaked, or staked this epoch) swaps from USDC into UNB, buys the entry's coin, and stakes it immediately for the caller with its chosen exit delay (24 hours by default).

Early in a route's life, `σ` is near zero, so almost all of each fetch buys coins off the curve, driving price discovery, rewarding early backers at the bottom of the curve, and turning early callers into staked owners. As adoption grows and `σ` rises, more of each fee pays out as USDC cash yield and less buys new coins. Callers never touch UNB, and nobody earns from their own fetch because stake begins earning in the next epoch. (Until an entry has a coin, its credited lister receives the USDC share directly.)

Staked coins earn only after their wallet has **checked** the entry by paying the listed price for a passed fetch served by another identity, or by serving a passed fetch paid by another identity. Self-paid calls never check. Checks never expire on a timer, avoiding wasteful synthetic traffic once callers have cached a working recipe.

## 7. Ranking by verified collateral and market cap

Clients choosing among competing entries need signals that an attacker must pay real money to move. Raw pass rates fall to cheap Sybil wash calls; raw market cap falls to unstaked speculative pumps. Unbrowse combines verified collateral and market value:

`S = √(Q · M)`

`M` is the coin's fixed 1,000,000,000 supply valued at its 24 hours time-weighted average price in UNB, capturing whether the market still values the route. `Q` is the UNB value of **counted stake**: coins actively staked by wallets that checked the entry and whose **own latest paid call on the entry passed**. When a caller's paid fetch fails, its stake drops out of `Q` immediately with no outside reporter.

Three rules harden `Q` against manipulation. First, stake is valued at the lower of its 24 hours average price and its immediate curve sale value, blunting flash spikes. Second, sale value is computed **last-out**, as if all unstaked coins sold back to the curve first, so unstaked buyers add zero collateral. Third, each stake scales with the unstaking delay its holder committed to, rewarding patient backing from block one without a warm-up clock.

`Q` sums linearly across stakes with no per-identity weight. In simulations of an earlier identity-weighted score, a rival running 900 wash calls across controlled wallets diluted honest weights in a small network and cut an honest route's rank by 95%; removing identity weight reduced that effect to zero and made splitting stake across Sybil wallets pointless. Clients pick proportionally to `S`, reserving 5% of public read-only picks to test entries below 30 uses.

## 8. Natural selection when websites change

Because coins follow byte hashes, Unbrowse needs no fault courts, repair pools or governance over upgrades. When a site changes, broken routes lose rank through ordinary behaviour and working replacements overtake them:

1. **Failing calls drain `Q`.** Callers whose cached copies break refetch, fail the mechanical check at $0 cost, and sign failed lines that immediately pull their stake out of `Q`.
2. **Zero yield drains `M`.** Failed lines pay stakers nothing, giving holders financial reason to unstake and sell back into the curve.
3. **A new body overtakes.** A node that misses walks the page in its browser, learns the updated request, and lists the new hash (42 of 100 fresh sites replayed without custom code in our tests). Each caller fetching the working fix buys and stakes its new coin; because those calls pass, every coin counts in `Q`. In our bounded model, a fix launched at one-tenth of the broken route's lister stake overtook it on its sixth fetch, whereas disabling auto-staking caused the fix to stall after one fetch (Appendix B).

## 9. Peer-to-peer discovery and serving

Nodes find and serve routes over a Kademlia hash table with no server on the call path. Because agents usually know their target domain, providers advertise signed listings under the registrable domain key; seekers pull listings from at least 2 distinct identities, verify them against on-chain roots, and rank locally. Leading 16 routing bits match a hash of each identity's paid registration and block hash, stopping free peer-ID eclipse attacks.

Any node that paid for a recipe seeds it by default while cached, keeping routes live when their lister is offline. Because clients check every served byte against the signed listing's hash, seeders cannot alter content, need no bond, and take no serving fee, earning through any stake they hold. Entries whose providers all go dark drop off rankings on a doubling schedule up to 32 epochs without forfeiting stake.

## 10. Bounties as limit orders

To fund unmapped sites before callers arrive, anyone can lock UNB in the bounty contract for a site or intent with a maximum price per coin (fees and tax included). That limit stops builders from pre-launching a coin, buying up its curve cheaply, and selling into the bounty: anything above the limit refuses to fill.

Bounties release without judges in two ways. First, once the sponsor's own paid fetch on an entry passes, the sponsor can confirm, buying coins up to its limit and splitting them 50% to the lister and half to the sponsor (both staked and verified, giving builders $0-upfront stake). Second, every counting paid fetch on the site after posting releases bounty UNB up to 5% of the line's USDC. Matching that cap to the 5% burn share ensures an attacker owning both the site and the stake never unlocks more bounty value via wash calls than it burns in fees. Unused UNB returns after the deadline, and the founder posts bounties on the same terms as anyone else.

## 11. Contract or client

Because peers upgrade voluntarily, money rules live in immutable contracts on Arc while selection and safety checks live in the client where each peer gains by running them:

| Mechanism | Where | Why it holds under mixed client versions |
|---|---|---|
| Splits, free failed lines, escrow, burns, curves, stakes, bounties | Contract | Moves USDC or UNB; checked from signatures and roots |
| Auto-staking coins bought on a fetch | Both | Lifts rank on routes the caller uses and earns future USDC |
| `√(Q · M)` rank and proportional pick | Client | Picks the route most likely to pass for the owner's agent |
| Mechanical call check, vault placeholders, host binding | Client | Protects the owner's own fees, answers and logins |
| BitTorrent-style recipe seeding | Client | Default sharing of cached bytes |

The contracts have no owner, admin key or token vote; rules change only when users move to a new deployment. Adopting route coins updates an earlier constitutional rule that barred stake from picks and awaits co-founder review alongside audit.

## 12. Threat model and accepted trade-offs

An attacker may create cheap identities, list or copy recipes, trade and stake coins, post bounties, mark its own calls failed, and wash-pay entries at chosen prices. Standard signatures, hashes and Arc settlement hold; nothing forfeits stake.

Wash-paying your own entry never counts as a check and loses the 30% site share plus 5% burn on every pass, underperforming an open curve buy. Splitting stake gains nothing under linear `Q`. Unstaked buys add zero last-out collateral and lift `M` only while paying curve fees and holding risk. The payer signs pass or fail itself, so a payer that signs every fetch failed gets every answer unpaid and keeps the body; nothing on chain bounds it, a cost the owner accepted to keep failures free. That payer gets no coin from the fetch and, having checked nothing, earns nothing on coin it buys, so the lie pays only a caller that does not want to hold the route.

In exchange for dropping identity weights, slashable bonds and fraud courts, the design accepts **three explicit costs**, besides the unbounded false failure above:

1. **Locked capital can buy rank.** Staking ten times an incumbent's stake after one check outranked it ~6:1 in our model. Free failures bound the harm: if the promoted route is broken, callers pay $0, the holder earns $0, and exiting pays curve fees.
2. **A heavily funded copy can out-earn backing the original.** Changing a byte starts a fresh curve at base price. Up to 10× the original lister's stake, backing the original coin pays better; at 30× launching a copy earns about 5% more and leaves the first lister about a tenth of its fees (callers get a working route either way). Because a modified copy and a genuine fix after a site break look identical on chain, blocking one would block permissionless replacement, so well-funded copies are accepted as competition.
3. **Silent holders slow decay.** A staker who neither fails a paid call nor sells keeps its slice of `Q` after a break; active callers drain their share immediately and $0 yield pushes rational holders out, though no timer forces a dormant wallet to exit.

Insiders who spot an upcoming site break early can also sell ahead of others, accelerating price discovery on dying routes.

## 13. Evaluation

Empirical website benchmarks come from Unbrowse's reference engine; economic results come from the executable Quint model `coins.qnt` at coarse integer scale (directional mechanics, never dollar forecasts; Appendix B):

| Question | Method | Result |
|---|---|---|
| Speed and cold discovery savings | Measured | 950 ms vs 3,404 ms browser mean (3.6×); saves $0.126 median cold model cost |
| Accounting, curve and rank invariants (20 total) | Quint (10 variants) | Held across 2,000 random 20-step traces per variant (simulation, not proof) |
| Broken route rank loss before any sales | Quint scenario | Four callers' failed fetches immediately drop rank 22% |
| Replacement overtaking broken incumbent | Quint scenario | Fix at 1/10th lister stake overtakes on 6th fetch; stalls if unstaked |
| Pay-then-buy lifecycle shift | Quint scenario | At 2%, 23% and 42% staked supply, next fetch pays ~that share in USDC |
| Wash volume vs open buy; rival wash | Quint scenario | 100 wash lines rank 8% lower at ~40% loss; 900 rival washes move rank 0% |
| Bounty limit order vs launch front-run | Quint scenario | 2× price cap fills zero overpriced coins; front-runner loses curve fees |

Five Lean 4 theorems verify the conserved split, the check rules and free failed lines (Appendix C); the coin contracts await formal proof.

## 14. Limits and open questions

Evidence for route coins rests on bounded simulations rather than live traffic. Earlier whole-web Monte Carlo runs prior to the 10 November rules found coins covering slightly fewer calls than alternatives; rerunning whole-web comparisons and measuring the closed pilot (~1,000 agents) remain ahead. Open parameters include whether to keep the latest-paid-call rule (since cached calls run off chain), exit-delay scaling, rank window length (24 hours), curve depth (30,000,000 UNB), wash-call payouts, signed-in route verification, and optional fetch relays for privacy. Finally, UNB launched before the contract audit and legal opinion that gate public opening, securities treatment of staked route-coin income awaits counsel, and the founder remains the main operational trust point until community listings overtake initial coverage.

---

## Appendix A. Empirical measurements

| Metric | Value | Source and method |
|---|---|---|
| Cold browser discovery cost | Median $0.126 per task | 26 cold tasks, frontier model, October 2026 |
| Execution speed (route vs browser) | 950 ms vs 3,404 ms mean (3.6×; 5.4× median) | 94 domains [2]; cached routes under 100 ms |
| Zero-code browserless replay | 42 of 100 sites | 100 fresh sites, generic script, September 2026 |
| Browser agents vs people | 14.41% vs 78.24% tasks | WebArena [1] |
| Host binding coverage | 50% declared; 96% with script check | 235 pages in headless Chromium, October 2026 |

Measured on Unbrowse's earlier hosted index and benchmark harness; no live route-coin network exists yet.

## Appendix B. Bounded Quint simulation results

Source: `coins.qnt` (`coins_current`, Quint 0.33.1; ancillary in `arxiv/anc/`). Coarse integer units: 1 coin unit = 1,000 coins (`1,000,000` supply), 1 UNB unit = 10,000 UNB (`3,000` virtual reserve), 1:1 initial UNB/USDC pool, exit-delay weight `delay / (delay + 1 day)`, and 65% / 30% / 5% split. Twenty invariants held across all ten modules over 2,000 20-step traces (seed `0x1`), up to rounding bounds.

**Replacement overtaking a broken route.** Broken route `b1` (lister `300` units + 4 callers, rank `1,117,598`) drops 22% to `868,191` when all four callers fail without selling. A replacement launched with `30` units overtakes on its sixth fetch:

| Replacement fetches | 0 | 4 | 5 | 6 | 7 | 8 | 16 |
|---|---|---|---|---|---|---|---|
| Replacement / broken rank | 0% | 84% | 95% | 105% | 116% | 126% | 206% |

Leaving fetched coins unstaked cut `b1` by 8% and stalled the replacement at `215,480` (1 fetch) and `228,651` (4 fetches).

**Pay-then-buy progression** (route share `65` per fetch, one fetch per day):

| Fetches so far | 1 | 4 | 16 | 48 |
|---|---|---|---|---|
| Supply staked (`σ`) | 2% | 8% | 23% | 42% |
| Next fetch paid to stakers (USDC units) | 1 | 5 | 15 | 27 |
| Coin units bought for next caller | 19,072 | 15,959 | 9,127 | 3,854 |

100 paid lines (`6,500` into a `100,000` pool) lifted UNB 13%; starting UNB at 2.25 bought 30% fewer coins and left rank at 42%.

**Copying vs backing (Finding F18).** 160 lines over 16 days against a lister with `300` staked (net USDC gain above `1,249` passive UNB appreciation):

| Challenger capital | Copying | Backing original | Lister (copied) | Lister (backed) |
|---|---|---|---|---|
| none | | | 2,497 | 2,497 |
| 30 | 364 | 692 | 1,792 | 2,509 |
| 300 | 1,322 | 2,284 | 1,538 | 2,550 |
| 1,000 | 3,589 | 4,613 | 1,053 | 2,667 |
| 10,000 | 8,323 | 7,942 | 260 | 5,679 |

At `3,000` capital (10× lister) over 48 days, backing yielded `20,382` vs `18,183` for copying.

**Other checks.** 100 wash lines (`10,000` USDC) ranked 8% below buying `6,500` UNB openly (`5,965` vs `6,369` coin worth); a washer with 10% staked recovered `695` USDC + `5,360` coins, losing `3,945`. Staking `3,000` on a rival outranked 6:1, earned 0 on break, and sold back for `2,986`. An unstaked `3,000` buy lifted rank +88% for one day and cost `61` in fees. Front-running a `3,000` bounty netted `2,337` uncapped vs `0` filled and `-14` loss under a 2× limit.

## Appendix C. Machine-checked proofs

Lean 4 theorems in `formal/` carrying over to conserved rules (coin contracts remain unproved):

| Theorem | Verified statement |
|---|---|
| `Unb.split_conserves` | Fee shares sum to exact price with zero remainder loss (`65 / 30 / 0 / 0 / 5` split) |
| `UnbVerify.self_paid_never_counts` | Self-paid lines never count as a check or serve |
| `UnbVerify.serving_counts_as_check` | Serving another identity's counting line records a check |
| `UnbVerify.unchecked_earns_nothing` | Unchecked wallets earn zero staking payout |
| `UnbLaunch.free_failure_costs_nothing` | A failed line charges nothing and pays nobody, whatever share of lines fail |

## Appendix D. Evolution of the design

Subjective caller ratings were dropped after 22 simulated reward schemes failed to make honest checking beat rubber-stamping (`R3.21`). Entry bonds, 50% payout withholding, fraud courts, server bonds, skills, execute prices and repair pools were retired on 8–9 November 2026 in favour of local credential prevention and hash-keyed route coins (`decide.route-coins-only`). On 10 November 2026, server and platform fee cuts folded into the 65% route share (`decide.one-part-to-stake`), the lister cut became the symmetric pay-then-buy rule (`coin.fetch-pays`), bounties became limit orders with a 5% use-release cap (`coin.bounty-limit`, `decide.bounty-cap-five`), and identity weights left `Q` (`decide.users-stake-no-weight`). Superseded rules remain in `unbrowse-graph`.

## Appendix E. Normative specification mapping

- **§1–§2:** `assume.browse-cost`, `assume.relearn`, `assume.hash-named`, `assume.pay-once`, `assume.cheap-identity`, `decide.route-coins`, `decide.peers-mixed`, `R1.1`, `R1.14`, `arc.erc8004`, `R2.1`, `R2.4`, `R2.14`, `R2.18`.
- **§3–§4:** `R2.8`–`R2.21`, `credential.never`, `decide.no-credential-leak`, `bond.none`, `R3.10`, `R3.12`, `R3.17`–`R3.21`, `R3.30`, `R3.33`, `decide.delist-not-a-power`, `R4.1`–`R4.8`, `R4.13`–`R4.15`, `decide.failed-fetch-always-free`, `attack.fail-keep-body`, `R4.32`, `R10.4`, `R10.5`, `execute.none`, `skills.none`, `decide.one-part-to-stake`.
- **§5–§6:** `coin.per-entry`, `build.oz-erc20`, `build.clank`, `coin.launch`, `coin.curve`, `coin.snipe-tax`, `coin.no-expiry`, `decide.no-graduation`, `coin.split`, `coin.holders-share`, `coin.fetch-pays`, `coin.fetch-buys`, `coin.fetch-stakes`, `coin.stake`, `coin.check`, `coin.claims`, `assume.self-pay-never-counts`, `decide.early-cheaper`, `decide.coins-never-expire`, `decide.split-by-stake`, `decide.coins-keep-91`.
- **§7–§10:** `rank.score`, `rank.counted-stake`, `rank.collateral`, `rank.twap-cap`, `rank.last-out`, `rank.exit-delay`, `rank.pick`, `R3.4`, `decide.rank-cap-no-clock`, `decide.users-stake-no-weight`, `route.replace`, `decide.no-repairs`, `decide.rank-collateral`, `decide.fetch-buys`, `R3.19`, `R7.1`–`R7.26`, `R7.34`, `decide.no-server-bond`, `decide.seeding-natural`, `coin.bounty-launch`, `coin.bounty-limit`, `coin.bounty-confirm`, `coin.bounty-by-use`, `coin.bounty-no-slicing`, `R8.12`, `decide.miss-pledges`, `decide.bounty-cap-five`.
- **§11–§14:** `R9.1`–`R9.30`, `R10.1`–`R10.15`, `R11.1`–`R11.14`, `deploy.new`, `fraud.none`, `decide.capital-copy-accepted`, `attack.capital-copy`, `attack.coin-bought-rank`, `attack.stayer`, `attack.insider-exit`, `attack.near-copy-coin`, `attack.bounty-front-run`, `quint.coins-rc`, `open.steefpls-review`, `open.coins-evidence`, `open.latest-call-rule`, `open.exit-delay-scale`, `open.rank-window`, `open.curve-depth`, `open.coin-unb-capture`, `open.coin-wash-calls`, `open.signed-in-route`, `decide.failed-fetch-always-free`, `open.counsel`, `open.pilot-coins`.

## References

1. S. Zhou et al. "WebArena: A Realistic Web Environment for Building Autonomous Agents." *ICLR*, 2024.
2. L. Tham, N. M. G. Garcia, J. Hahn. "Internal APIs Are All You Need." arXiv:2604.00694, 2026.
3. P. A. Samuelson. "The Pure Theory of Public Expenditure." *Review of Economics and Statistics* 36(4), 1954.
4. E. Ostrom. *Governing the Commons.* Cambridge University Press, 1990.
5. J. R. Douceur. "The Sybil Attack." *IPTPS*, 2002.

*This paper describes a network design that is not yet open, a live token, and parameters that may change before launch. Nothing here is an offer of any token or a promise of any return.*
