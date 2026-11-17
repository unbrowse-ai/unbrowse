# Spec status, part 1

This is a rule-by-rule status of [the protocol specification](../../papers/protocol.md) against this repository's code, chapters 0 to 5. It was checked on 11 November 2026 against the working tree on top of commit `fdded0f2b`, and updated on 12 November 2026 for `decide.failed-fetch-always-free`, which does not yet include uncommitted changes to the coin and settlement contracts (`CoinBounties.releaseByUse` buying only at `CoinFetch.steadyPrice` and keeping the unfilled share in `shareLeftOf`, and `LeanSettlement.NOTE_GAS = 1_400_000`).

## 0. Conventions

| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| R0.1 | This specification governs over papers, guides and pages | n/a | A rule about documents, not code |
| R0.2 | Read MUST, SHOULD and MAY as RFC 2119 says | n/a | Definition |
| R0.5 | Informative and Note text adds no requirement | n/a | Definition |
| R0.4 | Every rule carries its design graph identifier | n/a | Definition |
| R0.3 | Numbers are named by parameter key and resolved from params.toml | n/a | A writing rule. `papers/params_check.py` holds the mapped keys to the code's constants |
| R0.6 | Money in USDC smallest units, coins and burns in UNB, no oracle | built | `LeanSettlement` settles in its `usdc` token's units, `RouteCoins` curves are in UNB, prices come only from the UNB pool (`IUnbPool.steadyQuoteUnbOut`) |
| R0.7 | Epochs of 24 hours counted in Arc block numbers | differs | `LeanSettlement.epoch` counts blocks, but `CoinStakes` exit delays, `RouteCoins` snipe window and `CoinFetch` price window run on `block.timestamp` |

## 1. Accounts, wallets and identity

| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| R1.1 | One node learns, lists, fetches, serves and stakes under one wallet | built | `peers.rs` `start_serving` registers the wallet's identity, `derive.rs` `RootKey` holds every key the node uses |
| R1.3 | Listing is free, contributor earns by staking, USDC only before a coin | built | `CoinFetch.onLine` and `_oweContributor` pay the contributor only when no coin exists or the buy is too small |
| R1.4 | Contributor serves its own entries or designates hosts, serving share 0% | built | Own nodes and seeders serve (`peers.rs` `ServedListings`), no share for servers in `LeanSettlement._claim`. The rule asks for one or the other: the contributor serves its own, and any seeder may serve (R7.1). |
| R1.5 | Website posts no bond and its escrow accrues automatically | built | `LeanSettlement._claim` credits `escrow[domainHash]` on every paid line |
| R1.6 | Optional index nodes, built from signed listings, pinned embedding model | partly | Each node does the index work itself by word match over chain entries (`api/search.rs` `ask_network`, `network.rs`). No embeddings, no separate index node |
| R1.11 | Light mode searches, pays and learns locally and serves nothing | differs | `store.rs` `Settings.light` answers no lookups and seeds nothing fetched, but still serves bodies of routes it lists itself |
| R1.8 | Founder wallet holds team and treasury lines under ordinary rules | n/a | Governance and holdings, nothing for the code to do |
| R1.9 | Rewards reserve holds 10% and only posts hourly listing roots | partly | `reserve.rs` root poster is any node run with `UNBROWSE_RESERVE_POSTER=1` and pays its own gas. No reserve contract holding 10% |
| R1.10 | Platform has no privileged settlement power, 0% detail share | built | No owner, admin or pause in `src/lean` settlement contracts or `src/coins` (only devnet `UNB.sol` and `USDC.sol` faucets). `RouteCoins.FEE_RECIPIENT` takes the trade fee |
| R1.12 | One wallet owns nodes, keys, coins and claims, no accounts | built | `derive.rs` `RootKey.agent` derives every agent key from the root wallet, `owner_nodes.rs` lets one wallet pay for several nodes |
| R1.13 | Every EVM wallet treated alike, BIP-39 twelve words at m/44'/60'/0'/0/0 | built | `crates/core/src/seed.rs`, `link.rs` links Privy or any wallet by one signed message, `link.rs` `unlink` |
| R1.35 | No sign-up: default peer mode, local-only mode, optional linked wallet | built | `link.rs` (`on_network`, `funding`, `link_wallet`), `peers.rs` `start_serving`, `agents.rs` `ensure_first` |
| R1.14 | Each wallet registers at most one ERC-8004 identity | built | `erc8004.rs` `ensure` and `no_second` |
| arc.erc8004 | Use Arc's IdentityRegistry, record checks and stakes against agentId | differs | Registry used for listings only (`Listings.walletOf`). `CoinStakes.checked` and positions are keyed by wallet address, not `agentId` |
| R1.15 | Publish peer IDs, addresses, version and supportedTrust in ERC-8004 metadata | partly | `erc8004.rs` `publish` writes the keys and `registration_file` the trust list, but only one node at index 0 |
| R1.16 | Deposits indexed by agentId, payouts to getAgentWallet | differs | `LeanSettlement._accounts` is keyed by payer address and payouts go to addresses. No `getAgentWallet` call anywhere |
| R1.18 | Wallet certifies each node's peer key for sibling vault sync | not built | No sibling certificate or vault sync between an owner's nodes found (searched sibling, certificate, same owner) |
| R1.19 | Dashboard sign-in uses EIP-4361 | differs | `link.rs` `message` is a plain EIP-191 text, not an EIP-4361 message |
| R1.33 | Personhood is optional and gates only failure complaints | partly | `rank/reputation.rs` `Personhood` hook exists, `NoProofYet` verifies nobody |
| R1.34 | Which personhood providers qualify is open | n/a | Open question |
| R1.20 | App makes a capped, expiring spending key and authorises it on chain | built | `agents.rs` `ensure_first` ($5 `AUTO_CAP_USDC`) and `keep_granted`, `chain/grants.rs` `authorize`, `LeanSettlement.authorizeAgent` |
| R1.21 | Wallet and spending keys are ECDSA, checked with one ecrecover | built | `LeanSettlement._verify` (`ECDSA.tryRecover`) |
| R1.22 | Reject unauthorised, expired, revoked or over-cap keys, servers check first | built | `LeanSettlement._verify` and the cap check in `_claim`, `chain/discovery.rs` `check_agent` and `agent_room` |
| R1.23 | Spending and vault keys derived on device, separated from wallet key | built | `crates/core/src/derive.rs` `RootKey.agent` and `vault_key` hash the root with their own labels |
| R1.24 | Signed-in calls need an owner grant scoped by agent, site, actions, expiry | partly | `run.rs` asks the owner before a listed route acts in their session. No per-agent site grant with actions, limits and expiry found |
| R1.25 | Any state-changing request is a write whatever its HTTP verb | differs | `crates/learn` `ledger::writes_as` never counts GET or HEAD as a write |
| R1.37 | Walks attach the owner's stored session, probes run without one | unknown | Searched `browse.rs`, `learn.rs`, `store.rs` for a signed-in walk switch and session-free probes. `Settings.signed_in_calls` is read by nothing |
| R1.2 | Callers pay from Settlement deposits by voucher, no bond | built | `LeanSettlement.deposit` and `claimBatch` |
| R1.26 | Deposits only in native USDC, native value refused | built | `LeanSettlement` has no `receive`, `fallback` or payable function, deposits move `usdc` only |
| arc.usdc | Native USDC with ERC-3009 single-step deposits | built | `LeanSettlement.depositWithAuthorization` |
| arc.permit2 | Approvals go through Arc's Permit2 | not built | No Permit2 reference in contracts or node. `deposit` uses a plain `transferFrom` allowance |
| arc.multicall3from | Multi-step actions batch through Multicall3From | built | `rpc.rs` `batch` sends through `Multicall3From.aggregate3`, used by `erc8004.rs` `publish` and `chain/served.rs` |
| R1.27 | Withdrawals unlock 2 epochs after request | built | `LeanSettlement.requestWithdraw` and `withdraw`, `WITHDRAW_DELAY = 2` |
| R1.28 | Epoch is 24 hours of blocks and times the delays | built | `LeanSettlement.epoch`, `epochBlocks` set at deploy, `arc.rs` measures a day of blocks |
| R1.29 | Fund by earnings, card or CCTP, no coin trades without owner say | built | `link.rs` `fund_page` (Circle Onramp) and `funding` (CCTP v2 and Gateway addresses) |
| arc.cctp-gateway | Cross-chain USDC through Arc's CCTP v2 or Gateway | built | `arc.rs` `cctp_messenger` and `gateway_minter`, shown by `link.rs` `funding` |
| R1.30 | Show prices in dollars, coin balances in UNB with dollar estimate | partly | `money.rs` shows dollars, `chain/coins.rs` `Holding` has `value_unb` but no dollar estimate |
| R1.31 | Pay silently within key budget and $0.05 per-fetch ceiling | built | `store.rs` `MAX_FETCH_USDC = 0.05`, `api/call.rs` `over_max`, cap on chain in `LeanSettlement._claim` |
| R1.36 | Card prompts only above the owner's per-card, per-site limit | differs | `vault.rs` `CardLimit` authorises nothing: every card fill asks the owner (`api/browse.rs` `approve_checkout`) |

## 2. Routes, credentials and listings

| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| R2.1 | Entry is the tuple of domain, method, template, schema, session, version, hash, lister | built | `recipe.rs` `Recipe` holds site, method, endpoint, params, session, response and steps. `listing.rs` `SignedListing` holds version, content id and agent id |
| R2.2 | Session field names only the auth kind, never a secret value | built | `recipe.rs` `SessionType` (None, Cookie, Bearer). Secret inputs are `Param` with `secret: true`, filled from the caller's vault |
| R2.3 | Route identity hashes domain, method, template and output shape | differs | `learn.rs` names a route by Keccak of method, URL and GraphQL operation, cut to 8 bytes. The output shape is not hashed |
| R2.4 | Entry id is the algorithm-prefixed hash of canonical body bytes | built | `recipe::content_id` gives `sha256:` and hex. `Listings.entryIdOf` derives the entry from it |
| R2.5 | Hash the exact canonical bytes and verify served bodies before paying | built | `recipe::canonical`, `recipe::canonical_json` sort keys. `recipe::recheck` refuses a body whose hash or canonical form differs |
| R2.6 | Entries are immutable and a fix is a new entry | built | `listing.rs` `Book::next_version` gives a changed body a new version that names the one it supersedes |
| R2.7 | Bodies are data, not code, and calls stay on bound hosts | built | `recipe.rs` `Source` has no code variant. `recipe::check_foreign`, `goes_where_it_may` and `root_is_the_sites` refuse a body that breaks it |
| R2.9 | Body is a dependency graph tracing every value to its source | partly | `recipe.rs` `Source` traces each value to param, constant, response or session. A page-computed value is `Source::Browser`: no script URL, hash or entry function is carried for sandboxed replay |
| R2.8 | Learn only from the owner's browsing, offline routes stay local | built | `store::keep_learned` marks routes learned off the network as `local`. `main.rs` `list_route` refuses them. `autolist.rs` shows the owner a preview first (`preview_done`) |
| R2.10 | Strip secrets, type literals and drop response bodies before compiling | built | `learn.rs` moves bearer headers and storage values to the jar and drops secret defaults. `recipe::of_route` keeps no response and parameterises account identifiers |
| R2.11 | Deterministic open compiler rejects traces with unsourced credentials | built | `recipe::of_route` compiles deterministically and refuses, not scrubs, a route carrying a credential or unsourced value |
| R2.12 | Replay in a clean public context before listing, honour robots and rate limits | partly | Private and loopback hosts are refused (`egress.rs` `check`). No clean cookieless replay gates listing, and robots rules are checked for calls and listing (`optout.rs`, R4.32) but not before or during a walk. No per-site rate limit found |
| R2.13 | Signed-in and write routes list once scrubbed, callers use own session | built | `recipe::of_route` lists them with `Source::Session` placeholders. `recipe::into_route` fills every session value from the caller's own jar |
| credential.never | No credential in a recipe, detector scans on publish and on receipt | built | `recipe::of_route` runs `unbrowse_detector::scan` and the card check before listing. `recipe::recheck` scans every fetched body before keeping or running it. The detector is pinned as `unbrowse-detector/1`, where the spec leaves `fraud.detector` unset |
| R2.14 | Listing signed by the wallet key, binding terms and price schedule | partly | `Listings._offer` and `listing::judge` accept only the identity wallet's own signature. Terms carry one price amount, read with the contributor's single fee, not a price schedule |
| R2.14a | Share proven routes by default after 3 days or 5 runs, paced | built | `autolist.rs` `earned` with `DAYS_EARNED = 3` and `RUNS_EARNED = 5`. `ShareMode::per_day` gives 5 in used mode and 20 in all mode |
| R2.15 | Listing costs no gas, spreads by peers, clients verify signature and root | built | `main.rs` `list_route` writes nothing on chain. `listing::judge` checks the signer against the ERC-8004 identity and `chain::root_block` for a posted root |
| R2.16 | Append-only registry, only signer withdraws, coin unaffected | built | `LeanSettlement.delistEntry` and `relistEntry` by the contributor only. `listing::sign_withdrawal` for the signed withdrawal. `Domains.setSitePolicy` sets a site delisting |
| R2.21 | Relisting identical bytes points at the existing credited entry | built | `listing::judge` refuses a listing whose entry is credited to another contributor. `main.rs` `list_route` refuses to list a fetched body |
| R2.17 | Anyone may post a listing Merkle root with no bond | built | `LeanSettlement.postRoot` takes any caller and no deposit |
| R2.18 | Earliest root credits a body, recorded lazily, correctable for 14 epochs | differs | `Listings._offer` and `correctCredit` credit the earliest root at first show. The window is `CREDIT_FINAL_EPOCHS = 7`, not 14, and opens only after 5 USDC of outside paid use (`CREDIT_OPEN_USDC`) |
| R2.19 | Anchor the listing hash in a root before gossiping the body | built | `listing.rs` `post_pending` and `adopt_reserve_roots`. `autolist.rs` `Waiting::Unspread` holds a listing unspread until its root is posted |
| R2.20 | Reserve posts one batched listing root every hour | partly | `reserve.rs` poster posts one root an hour, run by any node with `UNBROWSE_RESERVE_POSTER=1`. The reserve does not fund it: the poster pays its own gas |
| R2.22 | Descriptions are untrusted hints, selection uses stake and verified calls | built | `rank.rs` uses descriptions for BM25 recall only. `api/goal.rs` picks with `rank::coin::order` |
| R2.23 | Descriptions have a maximum length | partly | `api/search.rs` `network_route_json` cuts a shown description to 300 characters. Nothing bounds it when a listing is signed. The spec leaves the value open |
| R2.24 | Nodes compute embeddings locally with a pinned open model | not built | No embedding code or pinned model found. `rank.rs` matches by BM25 over words and field names |
| R2.25 | Wrap untrusted listing text as quoted data for any model | built | `api/search.rs` `network_route_json` puts lister text under `listed_as`, cut short, with an `unverified` note to read it as data |
| R2.26 | Indexers may bootstrap from a verified registry snapshot | not built | No registry snapshot export or import found in `peers.rs`, `network.rs` or `crates/net` |
| R2.27 | A host binds to a site only by domain, site declaration or observed provenance | partly | `share::bound` binds by registrable domain (`identity::same_site`) or on-chain policy (`sitepolicy::declares`). No `related-website-set.json` or CSP `connect-src` reading. No browser-observed binding with a 30-epoch cache for fetched bodies |
| R2.28 | Block signed-in calls to unbound hosts, HTTPS and private-IP checks on every hop | partly | `share::bound` refuses session values to unbound hosts and makes no line. `egress.rs` `Egress::Foreign` holds every hop to HTTPS and public IPs. No `host not verified` flag found for unbound public hosts |
| R2.29 | Headless nodes bind hosts by rules a and b plus sibling certificates | partly | `share::bound` uses only rules a and b on every node. Sibling-certificate bindings are not read |
| route.replace | Broken routes are replaced by new entries, never patched in place | built | A changed body gets a new content id and version (`recipe::content_id`, `Book::next_version`). No contract function edits a listed entry. The stake side is under `rank.counted-stake` |

## 3. Discovery, calling and settlement claims

| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| R3.1 | Resolve cache, then peer listings, then browser walk | built | `api/goal.rs` `do_goal`: own routes (`routes_for`), then `network_goal`, then the browser |
| R3.2 | Four stages: scope, hybrid recall, rank.score, LLM tie-break | differs | `api/goal.rs` `network_goal` takes only listings whose words equal the goal's, others go to the agent. BM25 only in `rank.rs`, no embeddings, no fusion, no LLM tie-break |
| R3.3 | Filter listings above task budget or per-fetch cap | partly | `api/goal.rs` `over_max` skips entries over the owner's per-fetch maximum. No per-task budget found |
| R3.4 | 5% exploration picks for unverified entries, read-only, within free failures | partly | `api/goal.rs` `explores` (reads only; a failed line is always free), `rank/coin.rs` `order`. Coin path draws an unranked entry uniformly, not by contributor reputation. No signed-in exclusion found |
| R3.6 | Skip entries of wallets past daily fee capacity | not built | no capacity or K_a code in app/src or contracts |
| R3.7 | Index and DHT providers untrusted, candidates carry signature and root proof | built | `listing.rs` `judge` and `checked_found` verify signer and root, standings computed locally (`api/search.rs` `standings`) |
| R3.36 | Show all live entries, unverified tag, dark unavailable, delisted excluded | built | `api/search.rs` `entries` and `reputation_json`, `rank/reputation.rs` `UNVERIFIED_USES = 30`, `sitepolicy::delisted` |
| R3.37 | Agent may request a specific unverified entry by ID | built | `api/call.rs` `call_entry` takes an entry id, runs under `run_route` egress rules |
| R3.9 | Content hash from signed listing, verify bytes before paying | built | `share.rs` `fetch` takes `content_id` from the signed listing, `recipe::admit` drops a mismatch and sets the provider aside |
| R3.10 | Pay a voucher to fetch a body, browser fallback if all fail | built | `share.rs` `fetch` signs `network::sign_body_voucher` per ask, `api/goal.rs` falls back to the browser |
| R3.11 | Server checks voucher, deposit, key and failure count before release | built | `network.rs` `verify_body_voucher` checks key, cap, deposit less withdrawal, window. There is no failure count to read: a failed line is free (`decide.failed-fetch-always-free`). `accept_receipt` refuses a payer whose signed counts contradict the lines the server holds |
| R3.12 | Cache a working body and reuse it with no further fees | built | `share.rs` `keep`, `api/call.rs` `run_route` (a cached fetched route pays nothing) |
| R3.13 | EIP-712 voucher with cumulative, lines, passedLines, receiptRoot | built | `LeanSettlement.Voucher`, `VOUCHER_TYPEHASH`, `_verify` |
| R3.14 | Leaf Line fields with kind detail and one line per fetch | differs | `LeanSettlement.Line` is index, entryId, amount, passed, holders, bounty. No kind, author, domainHash or unanswered field. `bounty` is read by nothing |
| R3.15 | Fetch adds pending line, next voucher signs pass or fail | differs | `chain/claims.rs` `Reserved.network_line` reserves room before the fetch and writes one line after the use with its outcome. No pending line |
| R3.16 | Reconcile payee claims with commit-reveal reporting | n/a | open question |
| R3.17 | Pass only if status, host, schema, non-null and shape hash hold | differs | `crates/learn/src/replay.rs` accepts status 200 to 399, a challenge page fails, shape is compared by `answers_like` not a strict schema. `api/call.rs` bills a write route fetched for a read goal as passed with nothing run |
| R3.18 | Local model may downgrade a pass, never upgrade | not built | no model check of a call's answer found in `run.rs`, `api/call.rs`, `replay.rs` |
| R3.19 | On failure mark failed, try next candidate, then browser | built | `api/goal.rs` `network_goal` loop, `api/call.rs` `bill` writes the failed line |
| R3.21 | Mechanical check governs settlement, writes get async read-back | partly | line outcome is the call's own check (`api/call.rs` `bill`). No read-back for writes found |
| R3.22 | claim and claimBatch with proofs, payer backstop at half window | built | `LeanSettlement.claimBatch` (no single `claim`), `Listings.showAndClaim`, `chain/served.rs` `backstop_due`, `network.rs` refuses overdue payers |
| R3.23 | Each line settles once, payouts never exceed obligations or deposit | built | `LeanSettlement._claim`: `spentLine`, `OverCumulative`, `OverCap`, `InsufficientDeposit` |
| R3.24 | Settled claims are final | built | `LeanSettlement`: no function reverses a claim |
| R3.25 | Claims bump payer and entry counters on chain | partly | `CoinStakes.noteLine` notes every line per entry and payer, `Listings.creditPaid` sums paid use. No per-payer line counters (`FailureCap` is deleted), distinct domains, first active epoch, or entry served and unanswered tallies |
| R3.28 | Payees claim within 2 epochs of signing | differs | `LeanSettlement.CLAIM_WINDOW = 1`: the contract refuses a voucher after epoch e+1 |
| R3.29 | Prices and claims in USDC with no oracle | built | `LeanSettlement._claim` debits USDC, `poolBuy` guards by quotes not a feed |
| R3.30 | Contributor sets its entry's price freely, floor one unit | differs | `LeanSettlement.setFee` sets one fee for all of a contributor's entries. `listing.rs` `price` uses the higher of that fee and the listed price |
| R3.31 | Price schedule may vary by caller age and failure rate | not built | `ListingTerms.price` reads one amount, no schedule |
| R3.32 | Domain owners set a minimum fee floor via setSitePolicy | built | `Domains.setSitePolicy`, `sitepolicy.rs` `refuses` |
| R3.33 | Software suggests no default route price | built | `listing.rs` lists no price when the owner set no fee. Node also offers an auto fee that follows demand (`store.rs` `next_fee`), not in the spec |
| R3.34 | Search and executing cached routes are free | built | `api/call.rs` `run_route`: own and cached routes write no line |

## 4. Fee splits, website escrow and free-failure bounds

The spec text in `papers/` carries the same change (unbrowse-papers PR 111): §4.4, "Failed fetches are free".

| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| R4.1 | Passed line splits 65 route, 30 site, 0 server, 0 platform, 5 burn | built | `LeanSettlement._claim`, `ROUTE_PCT = 65`, `SITE_PCT = 30`, burn takes the rest |
| R4.2 | Integer shares sum to p, burn takes remainder, at least one unit | built | `LeanSettlement._claim`: `o.burn += amount - site - route` |
| R4.3 | Within-cap failed lines pay nobody | built | `LeanSettlement._claim` returns for every failed line, whatever share of its payer's lines fail (`decide.failed-fetch-always-free`) |
| R4.4 | Fee shares are immutable contract constants | built | `LeanSettlement` private constants, no setter |
| execute.none | No execute toll and no execute line kind | differs | no execute line exists, but `Domains.setSitePolicy` still takes and stores an `executePrice` nothing reads |
| skills.none | Every listing names a domain, no site-free split | built | `Listings._offer` reverts `NoSite` |
| R4.31 | No x402 handshake on calls to websites | built | no x402 or 402 handling in `run.rs` or `api/` (grep) |
| R4.6 | Burn buffer, burnBatch once per epoch, capped swap, caller margin | built | `LeanSettlement.burnBatch`, `poolBuy` (`BURN_BATCH_BPS = 50`, `BATCH_MARGIN_BPS = 1000`, fixed `BATCH_GAS`) |
| R4.7 | Disclose the burn as a buyback, not a price floor | n/a | disclosure. `docs/concepts/payments-and-unb.md` calls it a buyback |
| R4.8 | Batch burns per epoch against pool reserves, no price feed | built | `LeanSettlement.poolBuy` uses the steady quote as minimum out and refuses over 1% impact, which the spec leaves open |
| R4.12 | Websites post no bond | built | `Domains.claimEscrow` takes no deposit |
| R4.13 | Every passed line credits the domain escrow | built | `LeanSettlement._claim` adds the site share to `escrow[domainHash]` or pays `Domains.payee` |
| R4.14 | DNSSEC TXT proof claims escrow, 14 epoch wait, rotation restarts wait | built | `Domains.claimEscrow`, `releaseEscrow`, `payee`, `FixedDNSSEC.walletOf`. Wait is a constructor argument. A new wallet also clears the site policy |
| decide.dnssec-only | Domain binds to a wallet only by DNSSEC, no HTTP witnesses | built | `Domains.sol` has only the DNSSEC path |
| R4.16 | Unclaimed escrow disposition is open | n/a | open question |
| R4.17 | setSitePolicy floor, delist, up to 64 hosts, clients refresh per epoch | built | `Domains.setSitePolicy` (`HOSTS_MAX = 64`), `sitepolicy.rs` `refresh`, `refuses`, `declares` |
| R4.18 | Website operators may list routes for their own domains | built | `Listings._offer` puts no limit on who lists a site |
| R4.19 | Cross-site reputation counts only independently claimed domains | built | `rank/reputation.rs` `contributor_rate`, `escrow_claimed` |
| R4.32 | robots.txt Unbrowse disallow opts out, rechecked every epoch | partly | A client rule only (`decide.optout-client-side`). `optout.rs` reads the robots rules of each host a route sends to and `robots::disallowed_by_name` judges them: a route a group naming `Unbrowse` disallows is not called (`api/call.rs` `run_route`, `run.rs` `call_with`), listed (`autolist::tick`, `list_route`), served or announced (`share::listed_today`). Re-read once an epoch; a file that can't be read allows the call. Not built: the check before and during a browser walk |
| R4.20 | Free failures while f within 25% of max(n, 20) over 30 epochs | removed | Removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted |
| decide.fail-value-five | Past the floor, free failed value within 5% of counted paid value | removed | Removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted |
| R4.21 | n from closed epochs, f as max of declared and settled | removed | Removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted |
| R4.22 | Over-cap failed lines settle at full price | removed | Removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted |
| R4.24 | Exceeding the cap never bans a caller | removed | Removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted |
| R4.25 | Paying more never lowers allowance, avoided fees bounded | removed | Removed by `decide.failed-fetch-always-free` (12 Nov 2026): every failed line is free and `FailureCap.sol` is deleted |
| R4.26 | Estimate false-failure rate by Dawid-Skene EM | not built | no Dawid-Skene or false-fail estimate found (grep) |
| R4.27 | Servers may decline payers above 10% false-failure rate | not built | no false-failure gate in `network.rs` `verify_body_voucher` |
| R4.29 | On chain only the deterministic rho cap applies | built | No failure rule on chain at all: the ρ cap went with `decide.failed-fetch-always-free` |
| R4.33 | A passed line counts only if it paid at least the listed price | differs | `LeanSettlement._claim` compares with the contributor's on-chain fee at claim time, not the listing's price, and also refuses lines paid by the contributor's own party (`controllerOf`) |

## 5. Ranking, selection and diagnostic reports

| Rule | What it asks (under 15 words) | Status | Where |
|---|---|---|---|
| rank.score | Rank each entry by S = √(Q·M), nothing else entering. | built | `rank/coin.rs` `score`, fed by `chain/coins.rs` `rank_of` |
| rank.counted-stake | Count stake only from checked wallets whose latest paid call passed. | built | `rank/coin.rs` `StakeBook.counts`, `counted_stake` over `Checked` and `LineNoted` events |
| rank.exit-delay | Holder picks an exit delay, stake earns nothing during it, Q weights by delay. | built | `CoinStakes.requestUnstake` and `DEFAULT_DELAY`, `rank/coin.rs` `exit_delay_weight` (delay over delay plus a one-day median, the model's curve) |
| rank.collateral | Value counted stake in UNB at min of TWAP and last-out value. | built | `rank/coin.rs` `collateral` |
| rank.twap-cap | Value each stake at min(24-hour TWAP, last-out sale value). | built | `rank/coin.rs` `collateral`, `RANK_PRICE_WINDOW`, `chain/coins.rs` `twap` over `RouteCoins.observe` |
| rank.last-out | Last-out value assumes every unstaked circulating coin sells first. | built | `chain/coins.rs` `last_out` via `RouteCoins.quoteSell` |
| rank.pick | Pick budget-eligible entries in proportion to S, outside exploration. | partly | `rank/coin.rs` `order` from `api/goal.rs` `network_goal`. No daily wallet capacity (R5.22) applied |
| R5.22 | Skip entries of a wallet at its daily fee cap until next epoch. | not built | No capacity check found (grepped capacity, K_0, clean_share) |
| R6.12 | Wallet earns at most K_0 + γ·V_a in paid fees per epoch. | not built | No `K_a`, `capacity.base` or `capacity.clean_share` in node or contracts |
| R6.13 | Capacity depends only on clean earned fees, details open. | not built | No capacity to constrain. The rest is open |
| R5.16 | Diagnostic pass rate under Beta(2, 2) prior over decayed weighted uses. | built | `rank/reputation.rs` `rate`, `PRIOR_A`, `PRIOR_B`, `decay` (half-life 7 epochs, a client choice) |
| R5.17 | Challenger takes default when P(θc − θi > 0.02) ≥ 95%. | built | `rank/reputation.rs` `beats`, `next_default`, `SWITCH_MARGIN`, `SWITCH_CONFIDENCE` |
| R5.18 | Switch evidence only from payers over 2 hops from the lister. | partly | `rank/reputation.rs` `LINK_HOPS` link graph. No fallback to exploration picks when link recall is below 50% |
| R5.19 | No hysteresis on pass rate or switch test. | built | `rank/reputation.rs` `next_default` tests every epoch with no evidence floor |
| R5.20 | Version rank.score and R5.16 to R5.19 together. | partly | `rank/reputation.rs` `VERSION = 1` covers the pass rate only. `rank/coin.rs` carries no version |
| R5.2 | Entry reputation is weighted, decayed mean of report outcomes. | built | `rank/reputation.rs` `standings` over claimed lines from `chain/reputation.rs`, `w(j)` a client default while open |
| R5.3 | Passed lines count from any caller weighted by w(j). | built | `rank/reputation.rs` `standings` |
| R5.4 | Failures count only from verified persons, 1 a day, else 2-hour local demotion. | partly | `rank/reputation.rs` `Demoted`, `LOCAL_DEMOTION`, `COMPLAINTS_PER_DAY`. `Personhood` hook `NoProofYet` verifies nobody, so no failure reaches shared reputation |
| R5.5 | Cross-domain contributor reputation counts only independently claimed domains. | built | `rank/reputation.rs` `contributor_rate` |
| R5.6 | Write routes get a delayed read-back check in the caller's client. | not built | No read-back check found (grepped read_back, readback in node and crates) |
| R5.7 | Reports commit by hash in epoch and reveal after close. | not built | No report commitments. Reputation reads claimed lines directly. Only canary sets use commit and reveal |

