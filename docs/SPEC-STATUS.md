# Spec status

Where the code stands against the protocol specification, [`papers/protocol.md`](../papers/protocol.md), chapter by
chapter. That copy is the route-coin specification, synced from `protocol/spec/` in unbrowse-papers
(`papers/sync.py check`), and its Annex A is held to the code's own constants by `papers/params_check.py`. The concept
pages ([`concepts/`](concepts/papers.md)) explain the ideas, and each ends with what is in the code today.

This page and its two parts were rewritten on 11 November 2026, when the route-coin contracts replaced the earlier
economy (the five-way split, the entry bond, the route pool, the fraud court and the bounty stakes). The table below is
the summary by chapter; the parts check every rule against the code path that does it.

| Part | Covers |
|---|---|
| [Part 1](spec-status/part-1.md) | Chapters 0 to 5: conventions, accounts and identity, routes and listings, calling and claims, fees and escrow, ranking |
| [Part 2](spec-status/part-2.md) | Chapters 6 to 11: route coins, serving, bounties, supply, the constitution, launch. Then Annex A's parameters and the counts |

Of the 256 rules, 134 are built, 28 partly, 31 differ, 18 are not built, 35 are not this repository's to build
(launch, governance, definitions), 4 could not be settled from the code and 6 were removed by the owner's decision that
a failed fetch is always free (`decide.failed-fetch-always-free`, 12 November 2026). Of Annex A's 101 parameters, 58
match the code, 6 differ, 33 have nothing in the code yet and 4 were removed by that decision. The spec
text in `papers/` carries that decision (§4.4). The gaps that matter most:

- **No daily fee cap for a wallet** (R6.12, R3.6): the spec's limit on what a new wallet earns in a day is not built.
- **The claim window is one epoch, a hard cutoff** (R3.28, `CLAIM_WINDOW`), where the spec says a voucher should be
  claimed within two.
- **A listing's credit is final after 7 epochs, not 14** (R2.18, `CREDIT_FINAL_EPOCHS`), and its window opens only after
  5 USDC of paid use by others.
- **A line counts against the contributor's fee as read at the claim**, not the listed price (R4.33), and lines paid by
  the contributor's own party count for nothing.
- **A website's opt-out through `robots.txt` covers calls, listing and serving, not yet a browser walk** (R4.32, R2.12,
  `decide.optout-client-side`): a client rule, read by each node; the learner's walks don't check it yet.
- **Bounties release by use once, after the deadline**, at a steady price, and what a limit doesn't fill stays the
  entry's; the spec releases a slice per line and returns the rest to the sponsor (`coin.bounty-by-use`).
- **A bounty never launches a coin** (`coin.launch`, `coin.bounty-launch`; PR #549 review item 2): only the credited
  lister launches. `confirm` on an entry with no coin reverts `NoCoin`, and a release by use gives the share of an entry
  that had no coin at settle to the poster. The spec still lets a bounty launch; the papers have not been changed yet.
- **Coins a bounty buys for a lister are staked but not checked** (`coin.bounty-launch`), so they earn only after the
  lister's own counting call.
- **No rewards reserve contract** (R9.14, R9.15): the root poster pays its own gas.
- **The coin contracts time by `block.timestamp`**, where the spec counts in blocks (R0.7), and the snipe tax is burned
  at once instead of joining the burn buffer.

| Chapter | Status | Where |
|---|---|---|
| 0. Conventions | Built: epochs counted in the chain's blocks, fixed at deployment (R1.28) | `LeanSettlement.epoch`, `epoch_blocks` in the network file |
| 1. Accounts, wallets and identity | Built: the node's own wallet, agent keys with a cap per epoch and an expiry, an optional linked wallet, one wallet paying for several nodes, the ERC-8004 identity registered by the node itself. No admin key on any contract (R1.10) | `agents.rs`, `link.rs`, `erc8004.rs`, `LeanSettlement.authorizeAgent`; [ONBOARDING.md](ONBOARDING.md) |
| 2. Routes, credentials and listings | Built: signed listings under posted roots, credit to the earliest root at a body's first claim, delisting and relisting, automatic sharing. Not built: embeddings and the pinned model (R2.24); matching is by words | `listing.rs`, `autolist.rs`, `Listings.sol`; [LISTINGS.md](LISTINGS.md), [SHARING.md](SHARING.md) |
| 3. Discovery, calling and settlement claims | Built: running EIP-712 vouchers, receipt lines claimed with a Merkle proof, the claim window, the payee first, the payer's backstop and the watchtowers, a node's own routes free to its own agents. Differs: one price per contributor (`setFee`), where the spec has a schedule per entry (R3.30, R3.31). Not built: capacity (R3.6, R6.12) | `chain/claims.rs`, `chain/served.rs`, `watchtower.rs`, `LeanSettlement.claimBatch`; [MONEY.md §2](MONEY.md#2-every-action-that-needs-funds) |
| 4. Fee splits, website escrow and free-failure bounds | Built: the 65 / 30 / 5 split with no server's or platform's share, escrow per domain released to a wallet proven by DNSSEC only (`decide.dnssec-only`), every failed line free whatever its payer's failure share (`decide.failed-fetch-always-free`, which removed R4.20 to R4.25 and `decide.fail-value-five`), the burn batch. Not built: the statistical false-failure gate (R4.26 to R4.29), which the spec leaves to clients | `LeanSettlement._claim`, `Domains.sol`; [MONEY.md §3](MONEY.md#3-where-money-flows) |
| 5. Ranking, selection and diagnostic reports | Built: `S = √(Q·M)` computed by each node from chain reads, counted stake weighted by exit delay, the 24-hour price window, last-out collateral, 5% of read picks kept for entries with no rank. Not built: the reported pass rate and default entry (R5.16 to R5.19), commit-and-reveal reports (R5.7) | `rank/coin.rs`, `coin_rank`; [Search and ranking](concepts/search-and-ranking.md) |
| 6. Route coins, curves and pay-then-buy settlement | Built: one fixed-supply coin per credited entry on a permanent constant-product curve against UNB (no graduation, `decide.no-graduation`), the 1% trade fee and the snipe tax, staking in lots by exit delay with earnings from a running sum (nothing vests, `decide.no-claims-vest`), the fetch paying earlier stakers and buying for the payer within the drift bound, held buys completed later, the listing's first buy on by default (`decide.dev-buy-default-on`). No bond and no slashing (`decide.no-bond-no-slash-11nov`) | `chain/coins.rs`, compiled ABIs in `unbrowse-node/app/contracts/`, Quint coin model and contracts in the settlement repository |
| 7. Peer-to-peer serving, liveness and the hash table | Built: the libp2p network, provider records, holding and serving bodies, light mode, the dark set (each node's own, in memory). Partly: per-peer rate limits (R7.18, R7.26). Nothing is paid for serving | `crates/net`, `peers.rs`; [NETWORK.md](NETWORK.md) |
| 8. Bounties as judge-free limit orders | Built: post, confirm by the poster's own claimed call, settle, release by use capped at 5% of the USDC paid, refund; the node's bounty steps judged by the owner's agent, off by default | `CoinBounties.sol`, `chain/bounty.rs`, `autobounty.rs` |
| 9. Token supply, genesis allocation and burns | Built: buy-and-burn from the burn buffer once an epoch, the snipe tax burned. Outside this repository: the supply and allocation of mainnet's UNB, which the contracts take as an existing token | `LeanSettlement.burnBatch`, `RouteCoins.sol` |
| 10. Constitutional commitments and voluntary upgrades | Built: every contract immutable, no owner, no pauser, no upgrade path; a node holds a deployment to this build's code and the protocol's numbers before it uses it | `chain/conform.rs`, compiled ABIs in `unbrowse-node/app/contracts/` |
| 11. Staged launch, safety gates and handover | Not started: no network has the route-coin contracts deployed. The deployment of the contracts before route coins on Arc testnet is no longer read | [OPERATIONS.md](OPERATIONS.md) |
| Annex A. Parameters | 54 keys are mapped to a constant in the code and checked on every pull request (the four `refund.*` cap keys are removed, and listed as unmapped); the keys with nothing in the code yet are listed as unmapped in `papers/params-map.json` | `papers/params_check.py` |

## How this is checked

- **The text.** `python3 papers/sync.py check` fails when `papers/` differs from the papers repository at the ref it
  records.
- **The numbers.** `python3 papers/params_check.py` reads each mapped parameter's value out of the contract or node
  source and fails on a mismatch.
- **The design's model & contracts.** The settlement contracts and their Quint trace replay suite (`test/coins/QuintCoinsTraces.t.sol`) are maintained in the private settlement repository, and compiled ABIs are synced to `unbrowse-node/app/contracts/`.
