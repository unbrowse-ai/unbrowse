# Spec status, part 2

This is a rule-by-rule status of [the protocol specification](../../papers/protocol.md) against this repository's code, chapters 6 to 11 and the parameters of Annex A. It was checked on 11 November 2026 against the working tree on top of commit `fdded0f2b`, and updated on 12 November 2026 for `decide.failed-fetch-always-free`, which does not yet include uncommitted changes to the coin and settlement contracts (`CoinBounties.releaseByUse` buying only at `CoinFetch.steadyPrice` and keeping the unfilled share in `shareLeftOf`, and `LeanSettlement.NOTE_GAS = 1_400_000`).

## 6. Route coins, curves and pay-then-buy settlement

| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| coin.per-entry | One coin per entry, CREATE2 clone, salt = entry, fixed supply | built | `RouteCoins.launch` clones with `Clones.cloneDeterministicWithImmutableArgs`, salt is `entryId` (keccak of the content id), `SUPPLY` immutable set to 1e9 coins by `DeployCoins.s.sol` |
| build.oz-erc20 | Clone of OpenZeppelin ERC20, whole supply minted to curve, no admin | built | `RouteCoin` extends OZ `ERC20`, `initialize` mints once to the factory, no owner, burn, pause or hook |
| build.clank | Curve math adapts Clank with CL-02 and CL-03 fixed, no owners | built | `CoinMath` calls vendored `lib/clank` `ClankCurveMath` (MIT), deadlines and minimum outputs in `RouteCoins.buy` and `sell`, no owner. Only the math is taken from Clank |
| arc.unb | UNB reached through V4UnbPool adapter, coins price against UNB | built | `V4UnbPool.sol` over the v4 PoolManager, deployed by `chain/deploy.rs` when the network names a v4 pool. Curves price in UNB (`RouteCoins.UNB`) |
| coin.launch | Atomic launch: clone, curve, opening buy by bounty or credited lister | differs | `RouteCoins.launch` deploys, opens the curve and buys untaxed in one call. `_checkLauncher` allows only the contributor: a bounty never launches a coin (PR #549 review item 2, contracts README departure 16) |
| decide.dev-buy-default-on | Lister node launches with first buy of 1% wallet UNB by default | differs | `chain/coins.rs` `launch_listed`, `COIN_DEV_BUY_BPS = 100`. Launches once the entry is credited at its first paid claim, not at listing. The module comment still says OFF |
| coin.snipe-tax | Buys within 5 minutes pay tax decaying from 50%, to burn buffer | differs | `CoinMath.snipeTaxBps`, launch exempt. The tax is burned at once as UNB in `RouteCoins._burnUnb`, not routed to the USDC burn buffer |
| coin.curve | Constant-product curve, virtual 30M UNB, deadline, min out, 1% fee | built | `RouteCoins.buy` and `sell`, `VIRTUAL_UNB`, `TRADE_FEE_BPS = 100`. Fee accrues to `FEE_RECIPIENT` set at deploy (`COINS_FEE_RECIPIENT`), pulled by `withdrawFees` |
| decide.no-graduation | No graduation, no held-back supply, no coin pool | built | `RouteCoins.launch` puts all of `SUPPLY` on the curve, no graduation state or pool, `CoinMath.quoteBuy` never sells the last coin |
| arc.v4-poolmanager | UNB pool in Uniswap v4 PoolManager, addresses from env, coins use none | built | `chain/network.rs` `v4_pool` reads `UNBROWSE_<NET>_V4_*` variables, `V4UnbPool` takes the manager and key as constructor arguments |
| coin.no-expiry | No expiry or forced redemption, holders sell any time | built | `RouteCoins.sell` has no time gate, sale capped at real UNB reserve in `CoinMath.quoteSell` |
| coin.stake | Staked coins earn from next epoch close, chosen exit delay | built | `CoinStakes.stake`, `_stake` (pending until `ep + 1`), `requestUnstake` stops earning, `withdraw` after the delay |
| coin.check | Yield only after wallet verified entry via counting line, never expires | built | `CoinStakes.noteLine` and `_check`: payer on a counting line from another party, server when it is the contributor. Never cleared |
| bond.none | No listing bond, no withholding, stake is the only stake | built | No bond or withholding in `LeanSettlement._claim` or the coin contracts (grep for bond and withhold found none) |
| fraud.none | No fraud proofs, courts, slashing or forfeits | built | No slash, forfeit or dispute function in `src/lean` or `src/coins` |
| decide.no-bond-no-slash-11nov | Nothing takes funds except at owner's call, lots per stake | differs | `CoinStakes.reportFailed` sets only the caller's flag, no reward. Lots are keyed by exit delay, so a fetch's or bounty's coins join the wallet's own lot of that delay |
| coin.fetch-pays | Route share pays prior verified stakers, rest buys for caller | built | `CoinFetch.onLine` calls `CoinStakes.payHolders` (route share times earning over `SUPPLY`), rest to `_buyOrPark` |
| coin.fetch-buys | Unpaid share swaps USDC to UNB and buys coin for caller in claim | differs | `CoinFetch.buyFor`. Runs on every paid line, counting or not. A buy at an unsteady price parks for `completeBuy` later instead of running in the claim |
| coin.fetch-stakes | Bought coins stake for caller at its exit delay, count in Q | differs | `CoinFetch._buyAndStake` and `CoinStakes.stakeFor` at `fetchDelayOf` (24 hours default). With 8 lots full the coins go to the wallet unstaked |
| coin.split | Whole 65% to coin economy, lister paid only with no coin or dust | built | `LeanSettlement._claim` `ROUTE_PCT`, `CoinFetch._oweContributor` for no coin or `TooSmall`, pulled by `CoinFetch.withdraw` |
| coin.holders-share | O(1) accumulator pays each prior staked coin 1/supply | built | `CoinStakes.payHolders` raises `acc`, `_settle` and `_earned` per wallet |
| coin.claims | Staker claims from running sum, nothing vests | built | `CoinStakes.claim` pays `owed` at once, no vesting |

## 7. Peer-to-peer serving, liveness and the hash table

| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| R7.1 | Any node holding an entry's bytes may serve, contributor nodes found via ERC-8004. | built | `share.rs` `fetch` asks the contributor's registered nodes, then table providers |
| R7.3 | Seeders need no bond or reputation, unresponsive ones dropped locally. | built | No bond anywhere in serving. `crates/net/src/providers.rs` `Providers` sets failing providers aside |
| R7.6 | Serving share is 0% with no subsidy, an entry with no providers goes dark. | built | `LeanSettlement` split has no server share (`ROUTE_PCT = 65`). `share.rs` `Dark` |
| R7.18 | Seeders publish signed provider records, 1 hour TTL, 20 minute refresh, max 20. | differs | `crates/net/src/node.rs` TTL 60 min, refresh 20 min, `MAX_BODY_PROVIDERS = 20`, admission drops unregistered. Records are plain Kademlia records, not signed (contentId, agentId, sig). Seeding fetched bodies is opt-in (`serve_kept`) |
| R7.22 | One identity may run up to 16 nodes, each its own peer ID. | built | `crates/net/src/admission.rs` `admit`, `Rules { nodes_per_identity: 16 }` in `node.rs` defaults, `erc8004.rs` peer ID arrays |
| R7.34 | Full nodes serve kept listings and advertise providers by default. | differs | `store.rs` `serve_kept` is off by default. Kept routes are announced only when the owner turns it on (`peers.rs` `announces_kept`) |
| R7.5 | Serve bytes only against a valid voucher, funded deposit, live key, failure headroom. | built | `network.rs` `verify_body_voucher` checks voucher, key, cap, deposit less withdrawal, overdue backstop. No failure headroom exists to check: a failed line is free (`decide.failed-fetch-always-free`) |
| R7.19 | Hash every received body against the signed content id, mismatch unpaid. | built | `share.rs` `fetch` via `recipe::admit` (`Refusal::NotListed`), provider marked failed, nothing paid |
| R7.20 | Demote failing providers on doubling backoff to 32 epochs, scan bodies for credentials. | built | `crates/net/src/providers.rs` `exclusion`, `MAX_EXCLUSION = 32`. `share.rs` `fetch` refuses on `Refusal::Leaks` |
| R7.4 | Direct fetches reveal the content id, relay fetches are open. | n/a | Open question (`privacy.relay`) |
| R7.15 | Recipe bytes are public goods, not DRM, copies compete openly. | n/a | Definition |
| R7.11 | No bytes from any provider records an unanswered failed line, entry goes dark. | differs | `api/call.rs` writes a failed line with no server and calls `share::tried`. The entry leaves the ranking at once, not one epoch later |
| R7.12 | k-th dark epoch keeps an entry off rankings min(2^(k−1), 32) epochs. | built | `share.rs` `Dark.served_nothing`, `off_until` with `unbrowse_net::exclusion` |
| R7.13 | Going dark never forfeits stake. | built | No slashing or forfeit path in `src/coins` or `src/lean`. `share.rs` `Dark` only changes picks |
| R7.16 | Unanswered tries count as non-passes in diagnostic default tracking. | not built | `rank/reputation.rs` takes failures only from verified persons, and `NoProofYet` verifies nobody, so unanswered lines never count |
| R7.17 | When all network entries fail, walk the site in the browser and list it. | built | `api/goal.rs` runs `network_goal` first, then the browser walk |
| R7.9 | Resolve listings via the table, providers via metadata and records, lowest latency first. | partly | `share.rs` `fetch` and `crates/net/src/node.rs` `counted` order providers connected first. No latency measure |
| R7.21 | Index listings under /unbrowse/site/<domain>, fetch from 2 identities, verify, rank locally. | built | `crates/net/src/site.rs` `site_key`, `node.rs` `listing_sources: 2`, `api/goal.rs` verifies via `listing::verify` |
| R7.23 | Kademlia /unbrowse/kad/1.0.0, k 20, alpha 3, disjoint paths, client mode, relays. | built | `crates/net/src/node.rs` `KAD_PROTOCOL`, `kad::Config` with `disjoint_query_paths(true)`, relay, DCUtR and autonat. `peers.rs` light mode only asks |
| R7.24 | Bootstrap from cached peers, then ERC-8004 registered addresses. | partly | `erc8004.rs` `seeds` reads registered addresses. No store of previously seen peers found |
| R7.25 | Peer position prefix of 16 bits fixed by agentId and registration block hash. | built | `crates/net/src/position.rs` `target`, `placed`, `position_bits: 16` |
| R7.26 | Admit only peers proving key, listed in agentId metadata, correctly placed. | differs | `crates/net/src/admission.rs` `admit` does all three checks. Registry answers are cached 10 seconds (`REGISTRY_FRESH`), not one epoch |
| R7.27 | Table lookups are hints, fall back to an index node then the browser. | partly | `api/goal.rs` falls back to the browser. No index node exists |
| R7.28 | Broadcast signed delist and reprice notices on a per-site gossipsub topic. | built | `crates/net/src/changes.rs`, `share.rs` `announce_reprice`, `on_change` re-reads the chain |
| R7.29 | Per-peer token buckets, strangers' pool, 16 slots, 4 per peer, 2 second wait. | built | `crates/net/src/budget.rs` `LISTINGS_RATE`, `BODY_RATE`, `KAD_RATE`, `STRANGERS_*`, `SLOTS`, `SLOTS_PER_PEER`, `SLOT_WAIT` |
| R7.30 | Verify the Settlement deployment's bytecode on startup, refuse settlement if different. | built | `chain/conform.rs` `check` from `chain/network.rs` `usable` |
| R7.31 | Contracts cross-reference siblings, mismatched references rejected. | built | `chain/conform.rs` `check`, `check_coins`, `names` |
| R7.32 | unbrowse://<site>[/<entry>] links, reject ports, credentials, queries, fragments. | built | `routelink.rs` `parse` |
| R7.33 | Opening a link is read-only, no HTTP call, spend or session. | built | `api/open.rs` `do_open` shows listings only |

## 8. Bounties as judge-free limit orders

| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| coin.bounty-launch | Lock UNB, sponsor's passed fetch confirms, 50% coins to lister | differs | `CoinBounties.post`, `confirm`, `_buy` with `LISTER_SHARE_BPS = 5000`. A bounty never launches a coin: `confirm` on an entry with no coin reverts `NoCoin` and leaves the bounty open, and reverts `Unsteady` while the coin's snipe tax is above zero. Coins are staked by `stakeFor` but not marked checked, so the lister's half earns only after its own check |
| coin.bounty-confirm | Release by sponsor confirm or by organic use, no judges | differs | `CoinBounties.confirm` and `releaseByUse`. Use releases only after the deadline and only from an unconfirmed bounty, so the two paths exclude each other |
| coin.bounty-by-use | Each counting line releases up to 5% of its USDC from bounty | differs | `onCountingLine`, `_settle`, `releaseByUse`. One reserve fixed after the deadline, split by entry use, released by a call at a steady price only. Excludes the contributor's party. Unfilled share stays the entry's in `shareLeftOf`, not the sponsor's. Only an entry that left the site, lost its contributor or had no coin when the bounty was settled (`coinAtSettle`) gives its share to the poster |
| coin.bounty-limit | Sponsor sets max price, unfilled UNB stays with sponsor | differs | `CoinBounties._fill` and `_mostWithin`, fee and tax included, limit 0 buys at market. `confirm` also takes the poster's `maxCost` and reverts `CostAboveMax` above it; the node sends the quote kept from the owner's yes, never raised for a retry. On confirm the unfilled rest is refundable. On release by use it stays the entry's (`shareLeftOf`) |
| coin.bounty-no-slicing | Release is one market buy up to limit, no twap slicing | partly | `confirm` makes one buy. `releaseByUse` buys once per call but a share's unfilled rest is bought by later calls |
| R8.12 | Founder posts bounties as ordinary holder, no privileged path | n/a | Governance. `CoinBounties.post` is open to any wallet with no privileged path |

## 9. Token supply, genesis allocation and burns
| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| R9.1 | UNB supply fixed at one billion, minted once, no mint function. | unknown | The live token is outside this repository. `UNB.sol` here is a devnet faucet token with an owner mint. Searched src and script for a supply constant and found none |
| R9.2 | UNB has 18 decimals, used only for curves, bounties, swaps and burns. | built | `chain/amounts.rs` `UNB_DECIMALS = 18`, `DeployCoins.s.sol` checks UNB counts in 18 decimals |
| R9.3 | Genesis allocates the whole supply once across six lines. | n/a | Launch. Genesis allocation lives outside this repository |
| R9.4 | Public launch pool trades in UNB's existing pool, no treasury sales. | n/a | Launch |
| R9.4a | Team buys up to 7% at launch from disclosed wallets. | n/a | Launch disclosure |
| R9.12 | Team and treasury unlock only by time cliffs of 3 and 6 months. | unknown | No lock contract in this repository. Searched unbrowse-settlement for cliff, vesting, treasury, timelock and found nothing |
| R9.14 | Rewards reserve only funds hourly listing roots, nothing else. | not built | No reserve contract. `reserve.rs` says the reserve's repayment of root gas in UNB is not built, so the poster pays its own gas |
| R9.15 | Reserve outflows never exceed its 10% allocation. | not built | No reserve contract holds or caps outflows |
| R9.16 | Reserve has no expiry, no grants, no free UNB. | n/a | Launch commitment |
| R9.27 | Settlement swaps burns and fetch buys through UNB's existing public pool. | built | `LeanSettlement` constructor `pool` immutable, `poolBuy`, `CoinFetch` swaps via `POOL.swapUsdcForUnb`. The deploy script makes a test pool when a network names none |
| R9.28 | The pool's own 4% fee is the trade tax, no Settlement surcharge. | n/a | A parameter of the external pool. `V4UnbPool` swaps at the pool key's own fee. The devnet stand-in `UnbPool.FEE_BPS = 400` |
| R9.28a | The 4% trade tax goes to Unbrowse. | n/a | Set by the external pool, not by this code |
| R9.29 | UNB is burned from the 5% fee share and from snipe taxes. | built | `LeanSettlement.burnBatch` burns bought UNB. `RouteCoins._buy` burns the snipe tax at once with `_burnUnb`, not through the burn buffer |
| R9.30 | No minting after genesis, burns only, disclosed as buybacks. | built | No production contract in src/lean or src/coins mints UNB. Burns call `burn` or send to `0xdEaD`. Disclosure is a docs duty |

## 10. Constitutional commitments and voluntary upgrades
| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| R10.1 | The client must not migrate to a deployment breaking the invariants. | built | `chain/conform.rs` refuses a deployment whose code, links or route-coin numbers differ from this build |
| R10.2 | Zero UNB minted after genesis. | built | No contract in src/lean or src/coins can mint UNB. `RouteCoin.initialize` mints route coins only, once, from the factory |
| R10.3 | No owner, admin, pause or upgrade hooks on protocol contracts. | built | Grep of src/lean and src/coins finds Ownable only on devnet `UNB.sol` and `USDC.sol`. `FixedDNSSEC` zeroes its owner in the constructor. Coins are immutable `Clones`. Every wiring is a constructor immutable |
| R10.4 | Failures within the free cap charge nothing and pay nobody. | built | `LeanSettlement._claim` returns early for every failed line: no failure costs or pays anything (`decide.failed-fetch-always-free`) |
| R10.5 | Every passed fee reserves 30% for the domain owner's escrow. | built | `LeanSettlement._claim` `SITE_PCT = 30` to `escrow` or to the proven wallet from `Domains.payee` |
| R10.7 | Team and treasury unlock by time cliffs only. | unknown | No lock contract in this repository. Same search as R9.12 |
| R10.9 | Rewards reserve never matches earnings and pays no bounties. | not built | No reserve contract exists to hold this. Nothing in code pays from a reserve |
| R10.11 | Fee shares, delays, escrow wait, failure cap and margin are immutable. | built | `LeanSettlement` constants `ROUTE_PCT`, `SITE_PCT`, `WITHDRAW_DELAY`, `BATCH_MARGIN_BPS`, `Domains.escrowWait` constructor immutable |
| R10.12 | Launch and proposed parameters may be tuned in the pilot. | n/a | Governance |
| R10.13 | Prices and exit delays are chosen freely by participants. | built | `LeanSettlement.setFee` and `CoinStakes.setFetchDelay` take any value. The fee is one per contributor, not per entry |
| R10.14 | Rules change only by new deployments, no council, no voting. | n/a | Governance. No voting code exists |
| R10.15 | Node and contracts are open source and forkable. | n/a | Governance |
| deploy.new | Route coins ship as a fresh deployment nodes opt into by config. | partly | Both network files have `deployment: null`. This build runs only on a route-coin deployment, so the switch is by build, not by config (`networks/arc-testnet.json`) |

## 11. Staged launch, safety gates and handover
| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| R11.1 | Rollout runs in four phases: genesis, pilot, opening, handover. | n/a | Launch |
| R11.3 | The closed pilot exercises the whole protocol end to end. | n/a | Launch. No route-coin deployment exists on any network yet |
| R11.4 | Pilot is private, about 1,000 agents, no free UNB. | n/a | Launch |
| R11.5 | Opening is gated on R11.8, with no operator caps on chain. | n/a | Launch gate |
| R11.10 | The pilot measures and publishes seven benchmarks. | n/a | Off-chain process |
| R11.11 | Pilot findings calibrate proposed parameters before deployment. | n/a | Off-chain process |
| R11.8 | Opening is blocked until audit, legal and pilot gates pass. | n/a | Launch gate |
| R11.9 | Legal review covers pools, bounties, fees and token lines. | n/a | Off-chain process |
| R11.6 | Publish wallet, lock, pool and infrastructure disclosures before opening. | n/a | Disclosure |
| R11.12 | Disclose operator and caller concentration early on. | n/a | Disclosure |
| R11.13 | Disclose the founder as the primary operational trust point. | n/a | Disclosure |
| R11.14 | Track and report the founder's share of listed routes. | n/a | Off-chain process |
| R11.7 | Handover happens without contract changes or a central judge. | n/a | Launch |

## Annex A. Protocol parameters

`papers/params.toml` marks the four `refund.*` cap keys removed (unbrowse-papers PR 111).

| Parameter | Spec value | Constant in code | Status |
|---|---|---|---|
| `time.epoch` | 24 hours | `chain.rs` `EPOCH = 86_400` seconds, `DeployLean.s.sol` `EPOCH_BLOCKS = 86400`. Each network file sets `epoch_blocks` | matches |
| `time.withdrawal_delay` | 2 epochs | `LeanSettlement.sol` `WITHDRAW_DELAY = 2` | matches |
| `agent.key_cap` | $5.00 | `agents.rs` `AUTO_CAP_USDC = 5.0` | matches |
| `agent.max_fetch` | $0.05 | `store.rs` `MAX_FETCH_USDC = 0.05` | matches |
| `listing.credit_final` | 14 epochs (open) | `Listings.sol` `CREDIT_FINAL_EPOCHS = 7` | differs |
| `listing.reserve_root_interval` | 1 hour | `reserve.rs` `interval()` default 3_600 seconds | matches |
| `routes.binding_window` | 30 epochs | nothing in code. Grep for a binding window or TTL found none | nothing in code |
| `routes.description_max` | not set | nothing in code | nothing in code |
| `routes.optout_recheck` | 1 epoch | `optout.rs` `OPTOUT_RECHECK = chain::EPOCH` | matches |
| `routes.site_hosts_max` | 64 | `Domains.sol` `HOSTS_MAX = 64` | matches |
| `sharing.days` | 3 | `autolist.rs` `DAYS_EARNED = 3` | matches |
| `sharing.list_per_day` | 5 | `store.rs` `ShareMode::Used => 5` | matches |
| `sharing.list_per_day_all` | 20 | `store.rs` `ShareMode::All => 20` | matches |
| `sharing.runs` | 5 | `autolist.rs` `RUNS_EARNED = 5` | matches |
| `fees.batch_margin` | 10% | `LeanSettlement.sol` `BATCH_MARGIN_BPS = 1000` | matches |
| `fees.burn` | 5% | `LeanSettlement._claim` burn is the remainder after 65 and 30. `chain/wallet.rs` `SPLIT` burn 5 | matches |
| `fees.burn_batch_max_share` | 0.5% | `LeanSettlement.sol` `BURN_BATCH_BPS = 50` | matches |
| `fees.contributor` | 65% | `LeanSettlement.sol` `ROUTE_PCT = 65`, `chain/wallet.rs` `SPLIT` contributor 65 | matches |
| `fees.platform` | 0% | `chain/wallet.rs` `SPLIT` platform 0. The contract has no platform share | matches |
| `fees.server` | 0% | `chain/wallet.rs` `SPLIT` serving 0. The contract has no server share | matches |
| `fees.smallest_unit` | $0.000001 | No constant is needed: a line's amount is in USDC's own smallest unit, decimals read from the token at runtime (`LeanSettlement._claim`, `amount != 0`) | matches |
| `fees.suggested_detail` | not set (open) | `main.rs` `STARTING_FEE = 0.01` | differs |
| `fees.website` | 30% | `LeanSettlement.sol` `SITE_PCT = 30`, `chain/wallet.rs` `SPLIT` site 30 | matches |
| `refund.false_fail_gate` | 10% | nothing in code | nothing in code |
| `refund.fail_value` | 5% | removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted | removed |
| `refund.max_fail_rate` | 25% | removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted | removed |
| `refund.min_lines` | 20 | removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted. The node's payer record keeps its own `rank/reputation.rs` `RECORD_LINES = 20` | removed |
| `refund.window` | 30 epochs | removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted. The node's payer record keeps its own `rank/reputation.rs` `RECORD_WINDOW = 30` | removed |
| `escrow.unclaimed` | not set | nothing in code | nothing in code |
| `escrow.wait` | 14 epochs | `Domains.escrowWait` constructor immutable, from `DeployLean.s.sol` `ESCROW_WAIT = 14` and `chain.rs` `ESCROW_WAIT = 14` | matches |
| `route_coin.bounty_lister_share` | 50% | `DeployCoins.s.sol` `ROUTE_COIN_BOUNTY_LISTER_SHARE_BPS = 5000`, a constructor immutable | matches |
| `route_coin.bounty_use_cap` | 5% | `DeployCoins.s.sol` `ROUTE_COIN_BOUNTY_USE_CAP_BPS = 500`, a constructor immutable | matches |
| `route_coin.curve_share` | 100% | No constant. `RouteCoin.initialize(SUPPLY)` mints the whole supply to the curve's factory | matches |
| `route_coin.snipe_start` | 50% | `DeployCoins.s.sol` `ROUTE_COIN_SNIPE_START_BPS = 5000` to `RouteCoins.SNIPE_START_BPS` | matches |
| `route_coin.snipe_window` | 5 minutes | `DeployCoins.s.sol` `ROUTE_COIN_SNIPE_WINDOW = 5 minutes` to `RouteCoins.SNIPE_WINDOW` | matches |
| `route_coin.supply` | 1,000,000,000 | `DeployCoins.s.sol` `ROUTE_COIN_SUPPLY = 1_000_000_000 ether` to `RouteCoins.SUPPLY` | matches |
| `route_coin.trade_fee` | 1% | `DeployCoins.s.sol` `ROUTE_COIN_TRADE_FEE_BPS = 100` to `RouteCoins.TRADE_FEE_BPS` | matches |
| `route_coin.dev_buy_share` | 1% | `store.rs` `COIN_DEV_BUY_BPS = 100` | matches |
| `route_coin.unstake_delay` | 24 hours | `DeployCoins.s.sol` `ROUTE_COIN_UNSTAKE_DELAY = 24 hours` to `CoinStakes.DEFAULT_DELAY` | matches |
| `route_coin.virtual_unb` | 30,000,000 UNB | `DeployCoins.s.sol` `ROUTE_COIN_VIRTUAL_UNB = 30_000_000 ether` to `RouteCoins.VIRTUAL_UNB` | matches |
| `rank.identity_window` | 720 hours | nothing in code. The rank has no identity weight | nothing in code |
| `rank.price_window` | 24 hours | `rank/coin.rs` `RANK_PRICE_WINDOW = 24 * 3600` | matches |
| `ranking.evidence_cap` | not set | nothing in code | nothing in code |
| `ranking.exploration_share` | 5% | `rank/reputation.rs` `EXPLORATION_SHARE = 0.05` | matches |
| `ranking.link_hops` | 2 | `rank/reputation.rs` `LINK_HOPS = 2` | matches |
| `ranking.link_recall_min` | 50% | nothing in code | nothing in code |
| `ranking.prior_a` | 2 | `rank/reputation.rs` `PRIOR_A = 2.0` | matches |
| `ranking.prior_b` | 2 | `rank/reputation.rs` `PRIOR_B = 2.0` | matches |
| `ranking.switch_confidence` | 95% | `rank/reputation.rs` `SWITCH_CONFIDENCE = 0.95` | matches |
| `ranking.switch_margin` | 0.02 | `rank/reputation.rs` `SWITCH_MARGIN = 0.02` | matches |
| `ranking.unverified_uses` | 30 | `rank/reputation.rs` `UNVERIFIED_USES = 30` | matches |
| `rating.canary_penalty` | not set (open) | `rank/reputation.rs` `CANARY_PENALTY = 30` epochs | differs |
| `rating.canary_share` | 5% | nothing in code. `update.rs` `canary_share` is the release channel, unrelated | nothing in code |
| `rating.complaints_per_day` | 1 | `rank/reputation.rs` `COMPLAINTS_PER_DAY = 1` | matches |
| `rating.decay` | not set (open) | `rank/reputation.rs` `HALF_LIFE = 7.0` epochs | differs |
| `rating.declared_fault` | not set | nothing in code | nothing in code |
| `rating.escalation_start` | not set | nothing in code | nothing in code |
| `rating.local_demotion` | 2 hours | `rank/reputation.rs` `LOCAL_DEMOTION = 2 * 3600` seconds | matches |
| `rating.payer_weight` | not set (open) | `rank/reputation.rs` `AGE_HALF = 7.0`, `SPEND_HALF = 0.5`, `SPREAD_HALF = 5.0` | differs |
| `rating.rebuttal_window` | not set | nothing in code | nothing in code |
| `liveness.detection_lag` | 1 epoch | nothing in code | nothing in code |
| `liveness.penalty_cap` | 32 epochs | `crates/net/src/providers.rs` `MAX_EXCLUSION = 32` | matches |
| `liveness.reports` | not set | nothing in code | nothing in code |
| `dht.alpha` | 3 | `crates/net/src/node.rs` `alpha: 3` | matches |
| `dht.k` | 20 | `crates/net/src/node.rs` `k: 20` | matches |
| `dht.listing_sources` | 2 | `crates/net/src/node.rs` `listing_sources: 2` | matches |
| `dht.nodes_per_identity` | 16 | `crates/net/src/node.rs` `nodes_per_identity: 16` | matches |
| `dht.position_bits` | 16 | `crates/net/src/node.rs` `position_bits: 16` | matches |
| `dht.query_rate` | burst 512, then 32 a second | `crates/net/src/budget.rs` `KAD_RATE` burst 512, 32 a second | matches |
| `serving.body_rate` | burst 20, then 1 a second | `crates/net/src/budget.rs` `BODY_RATE` burst 20, 1 a second | matches |
| `serving.listings_rate` | burst 32, then 1 a second | `crates/net/src/budget.rs` `LISTINGS_RATE` burst 32, 1 a second | matches |
| `serving.max_providers` | 20 | `crates/net/src/body.rs` `MAX_BODY_PROVIDERS = 20` | matches |
| `serving.provider_record` | 1 hour | `crates/net/src/node.rs` `provider_ttl: 60 * minute` | matches |
| `serving.provider_refresh` | 20 minutes | `crates/net/src/node.rs` `provider_refresh: 20 * minute` | matches |
| `serving.slot_wait` | 2 seconds | `crates/net/src/budget.rs` `SLOT_WAIT = 2` seconds | matches |
| `serving.slots` | 16, one for a newcomer, 4 per peer | `crates/net/src/budget.rs` `SLOTS = 16`, `SLOTS_PER_PEER = 4` | matches |
| `serving.strangers_rate` | listings and bodies 64 then 4, hash table 1,024 then 64 | `crates/net/src/budget.rs` `STRANGERS_LISTINGS`, `STRANGERS_BODIES` 64 and 4, `STRANGERS_KAD` 1024 and 64 | matches |
| `privacy.relay` | not set | nothing in code | nothing in code |
| `capacity.base` | $2.00 | nothing in code | nothing in code |
| `capacity.clean_share` | 0.2 | nothing in code | nothing in code |
| `fraud.detector` | not set (open) | `crates/detector/src/lib.rs` `VERSION_NUMBER = 1` | differs |
| `supply.decimals` | 18 | `chain/amounts.rs` `UNB_DECIMALS = 18` | matches |
| `supply.minted_after_launch` | 0 UNB | No constant. No production contract mints UNB | nothing in code |
| `supply.total` | 1,000,000,000 UNB | nothing in code. The live token is outside this repository | nothing in code |
| `allocation.airdrop` | 0% | nothing in code | nothing in code |
| `allocation.public_pool` | 67% | nothing in code | nothing in code |
| `allocation.reserve` | 10% | nothing in code | nothing in code |
| `allocation.team` | 8% | nothing in code | nothing in code |
| `allocation.team_launch_buy_max` | 7% | nothing in code | nothing in code |
| `allocation.treasury_1` | 5% | nothing in code | nothing in code |
| `allocation.treasury_2` | 10% | nothing in code | nothing in code |
| `vesting.lock_long` | 6 months | nothing in code | nothing in code |
| `vesting.lock_short` | 3 months | nothing in code | nothing in code |
| `pool.fee` | 4% | `Pool.sol` devnet stand-in `UnbPool.FEE_BPS = 400`. The live pool sets its own | matches |
| `pool.own_lp` | not set | nothing in code | nothing in code |
| `pool.seed_lock` | not set | nothing in code | nothing in code |
| `pool.seeding` | existing public pool | No constant. `LeanSettlement` constructor takes `pool_`, the network file names it in `existing.pool` | matches |
| `pool.trade_tax` | 4% | No constant. It is the pool's own fee, see `pool.fee` | nothing in code |
| `pool.trade_tax_to` | Unbrowse | nothing in code | nothing in code |
| `launch.pilot_agents` | 1,000 | nothing in code | nothing in code |
| `launch.pilot_length` | not set | nothing in code | nothing in code |

## Counts

| Chapter | built | partly | differs | not built | n/a | unknown | removed | Rules |
|---|---|---|---|---|---|---|---|---|
| 0. Conventions | 1 | 0 | 1 | 0 | 5 | 0 | 0 | 7 |
| 1. Accounts, wallets and identity | 22 | 6 | 6 | 2 | 2 | 1 | 0 | 39 |
| 2. Routes, credentials and listings | 20 | 8 | 2 | 2 | 0 | 0 | 0 | 32 |
| 3. Discovery, calling and settlement claims | 17 | 4 | 6 | 3 | 1 | 0 | 0 | 31 |
| 4. Fee splits, website escrow and free-failure bounds | 16 | 1 | 2 | 2 | 2 | 0 | 6 | 29 |
| 5. Ranking, selection and diagnostic reports | 12 | 4 | 0 | 5 | 0 | 0 | 0 | 21 |
| 6. Route coins, curves and pay-then-buy settlement | 16 | 0 | 6 | 0 | 0 | 0 | 0 | 22 |
| 7. Peer-to-peer serving, liveness and the hash table | 19 | 3 | 4 | 1 | 2 | 0 | 0 | 29 |
| 8. Bounties as judge-free limit orders | 0 | 1 | 4 | 0 | 1 | 0 | 0 | 6 |
| 9. Token supply, genesis allocation and burns | 4 | 0 | 0 | 2 | 6 | 2 | 0 | 14 |
| 10. Constitutional commitments and voluntary upgrades | 7 | 1 | 0 | 1 | 3 | 1 | 0 | 13 |
| 11. Staged launch, safety gates and handover | 0 | 0 | 0 | 0 | 13 | 0 | 0 | 13 |
| Total | 134 | 28 | 31 | 18 | 35 | 4 | 6 | 256 |

Annex A has 101 parameters: 58 match the code, 6 differ, 33 have nothing in code, and 4 were removed by `decide.failed-fetch-always-free`.
