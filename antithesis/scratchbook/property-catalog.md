---
sut_path: <checkout>/antithesis
commit: e96f00c1e97085c40dd1455335a4d75bd7fb5c09
updated: 2026-10-30
external_references:
  - path: <checkout>/papers/protocol.md
    why: Numbered protocol requirements (R2, R3, R6, R7) read as claims to test.
  - path: <checkout>/papers/economy.md
    why: Fee rail, split, bond, withholding, vesting, burn, read as claims to test.
  - path: AGENTS.md, CLAUDE.md (repo root)
    why: Network rules ("one owner is one source", standing from the registry); fixes stated as properties.
  - path: <checkout>/autofetch (branch autonomous-fetch, PR #53)
    why: The no-approval spending path; read as a lead by the wildcard focus.
---

# Property catalog: the Unbrowse node's network and money paths

The research ran as an ensemble: one SUT-analysis agent, then four discovery agents.

| Agent | Focuses |
|---|---|
| Money | 1 Data Integrity, 6 Security Boundaries, 9 Idempotency and Replay |
| Peer network | 7 Distributed Coordination, 4 Protocol Contracts, 10 Version Compatibility |
| Concurrency and lifecycle | 2 Concurrency, 3 Failure Recovery, 5 Resource Boundaries, 8 Lifecycle Transitions |
| Wildcard | 11 |

Each property has an evidence file at `properties/{slug}.md`. That file holds the full Property, Invariant, Antithesis Angle, Why It Matters and Open Questions fields, the code paths and the investigation log.

The repo has no Antithesis SDK, so every assertion named here is missing (see `existing-assertions.md`).

**Status:**
- **C**: confirmed defect, shown by a probe or test in a scratch copy.
- **R**: confirmed by reading control flow that doesn't depend on timing.
- **S**: suspected.
- **H**: expected to hold; kept as a regression guard.

**Priority:**
- **P0**: money or security harm on the live path.
- **P1**: the network or node stops working.
- **P2**: degraded behaviour or a guard.

## Status at e96f00c1, and where each property is checked

The research ran at 91115204. PRs #59-#68 since then fixed most of what it confirmed, so most properties are now
regression guards: **H** below means expected to hold on current code. The research-time status stays in the tables
further down. "SUT" names the node's own assertions (behind the `antithesis` feature, `unbrowse-node/app/src/antithesis.rs`
and `crates/net/src/antithesis.rs`); "workload" names a test command under `antithesis/test/unbrowse/`. Details,
the assertion messages and the deferred list are in `harness.md`.

| Slug | Now | Implemented |
|---|---|---|
| `settlement-unb-covers-every-bond` | H (#59 pool) | workload `helper_invariants.check` (anytime, finally) |
| `settlement-usdc-equals-its-liabilities` | H (#59) | workload `helper_invariants.check` |
| `serving-share-pays-the-node-that-served` | H (#60); a payer naming a second wallet it owns can't be told apart (human) | workload `helper_invariants.check`; call driver's seeder reach claim |
| `cap-is-checked-before-the-site-is-called` | H (#60 `chain::reserve`); residual: a disk error writing the line after the site call | SUT `chain::reserve`, `Reserved::line` |
| `a-kept-body-was-paid-for` | H (#60) | SUT `api.rs` before each `share::keep`; workload bounds in `finally_settlement_and_bounds` |
| `no-passed-line-past-the-cap` | H (#60) | SUT `chain::write_line`; workload claimed ≤ cap per epoch |
| `one-unpayable-line-never-blocks-the-rest` | H (#60, #68 batches by gas) | workload `eventually_lines_claimed` |
| `vesting-stays-withdrawable` | H (#60 buckets) | workload `helper_invariants.check` (estimate per earner) |
| `each-line-is-paid-at-most-once` | H | workload `helper_invariants.check` |
| `passed-lines-are-claimed-within-their-window` | H while the payer's node runs (#60, #61, #68 `claim_due`); receipts still can't cross machines (`send_receipt`) | SUT `chain::claim` (`claim_due` never holds back a closed epoch); workload `eventually_lines_claimed` |
| `receipt-ledger-never-shrinks` | H (#60 strict reads) | workload `helper_invariants.ledgers` |
| `body-voucher-releases-one-body` | open, low value (`SPENT` in memory) | deferred: needs a raw body client (net-only harness) |
| `the-per-fetch-maximum-bounds-the-same-currency-the-fee-is-in` | H (#66) | partly: call driver bounds what a call pays; the owner driver moves the maximum around the fee |
| `a-server-never-releases-a-body-for-less-than-its-current-fee` | H server side; caller-side reprice race open | partly: owner driver reprices during calls; no SUT assertion |
| `auto-pricing-moves-the-fee-once-per-epoch` | H (#60) | deferred: manual and automatic `FeeSet` can't be told apart on chain |
| `network-write-never-auto-run-for-a-read-intent` | H on the paid path (#53); residual: `do_goal`'s local pick of a kept write route for a goal with no read or write word | SUT `call_entry` (the 409 and the run); workload call driver (read and write goals, a write route fixture) |
| `a-state-change-is-never-classified-a-read-by-its-endpoint-name` | open (`ledger::writes`) | deferred: a learner property, better as a unit test |
| `a-shared-body-never-reaches-a-host-off-its-site-nor-a-private-address` | open (re-walk after a heal) | partly: the shop sees only the callers' own sessions; deferred for a hostile body (needs an adversarial node) |
| `a-delisted-or-superseded-route-is-not-run-from-cache` | H for delisting (#65); superseded versions run by design | SUT `share::still_listed`, `run_route`; workload call driver after a delist |
| `caller-runs-only-the-signed-body` | H | partly: kept-body checks; tampered provider deferred (adversarial node) |
| `served-body-matches-signed-content-id` | H | as above |
| `delisted-or-underpaid-body-never-released` | H | not added: the check is the code itself (`share::release`) |
| `lookup-keeps-newest-listing-version` | open, human (Q8) | deferred |
| `entry-dark-only-when-providers-served-nothing` | H (#61) | deferred: needs provider internals |
| `nodes-booting-together-find-each-other` | H (#61) | workload `eventually_network_recovers`; the three nodes boot together |
| `admission-recovers-after-registry-stall` | H (#61) | SUT `node.rs` (unread, asked again, admitted after a failed read); workload `eventually_network_recovers` |
| `too-old-peer-never-counts` | H (#61) | SUT `node.rs` `standing`, `judged`; unreachable here (no `min_peer_version` outside release builds) |
| `listings-answering-survives-a-stuck-answer` | H (#61) | SUT `node.rs` slots and the given-up answer |
| `listings-answer-fits-its-bound` | H (#61) | SUT `node.rs` before `send_response` |
| `node-on-network-after-first-publish-fails` | H (#61) | workload `eventually_network_recovers` |
| `checked-lookup-spans-two-identities` | H | deferred: the search reply's `checked` with a seeder serving is a follow-up |
| `two-distinct-identities-is-only-as-strong-as-registration-is-costly` | human | deferred |
| `table-role-follows-reachability` | H | deferred: a flat network makes every node a server |
| `light-mode-answers-no-queries-on-any-protocol` | H as narrowed (#61) | partly: the owner driver toggles light on node-3; no assertion yet |
| `owner-key-writes-never-share-a-nonce` | H (#61 `rpc::WRITING`) | SUT `rpc::write_turn`, `rpc::not_sent` |
| `one-erc8004-identity-per-owner` | H (#61) | workload `helper_invariants.identities` |
| `holding-on-chain-converges-to-held-json` | H in `hold_tick`; the owner's `hold_route` still writes no record | SUT `peers.rs`; workload `eventually_network_recovers` (the driver never sends `hold_route`) |
| `background-pass-completes-after-chain-faults-stop` | H (#61 bounds) | SUT `main.rs` `claim_loop`; workload `eventually_lines_claimed` |
| `boot-failures-heal-without-restart` | H (#61) | workload `eventually_network_recovers` |
| `claim-loop-runs-while-off-the-peer-network` | H (#61) | owner driver turns `peer_network` off; `eventually_lines_claimed` doesn't turn it back on |
| `kept-manifest-pair-never-lowers-min-version` | H (#61) | deferred: the update path isn't in this topology |
| `every-listed-entry-is-served-even-when-its-body-is-shared` (new, found on the deck) | H (fixed on `harness-defects`: a release is decided by the voucher's own entry) | workload `parallel_driver_call` (`call_lookup`: route-lookup and route-cart list one body); app test `share::a_body_listed_twice_is_one_entry_and_served_under_it` |
| `a-site-listed-by-nodes-booting-together-is-found` (new, found on the deck) | H (fixed on `harness-defects`: "not listed" is retried on a short backoff, records held, re-announced while the table is small) | workload `eventually_network_recovers`, setup lists at once; SUT `node.rs`; net test `liveness::a_site_listed_by_nodes_booting_together_is_found` |

## A. Settlement and money

| Slug | Type | Main assertion | Pri | Status |
|---|---|---|---|---|
| `settlement-unb-covers-every-bond` | Safety | `Always` UNB held ≥ filled + unbonding bonds | P0 | **C**: a 0-bond wallet unbonds UNB withheld from USDC; 12 held against 22 owed (`LeanSettlement.sol:694-699,522-531`) |
| `settlement-usdc-equals-its-liabilities` | Safety | `Always` USDC held == deposits + escrow + vesting | P0 | **C**: the withheld USDC is stranded with no way out |
| `serving-share-pays-the-node-that-served` | Safety | `Always` the named server is credited 5% | P0 | **C**: paid only to `holding[h][entry]`; seeders never hold, so the share burns (`:980`, `store.rs:464`) |
| `cap-is-checked-before-the-site-is-called` | Safety | `Always` a cap refusal made no site request | P0 | **C**: the pre-check misses pending lines; the 402 comes after the site call, so a retry writes twice (`api.rs:750`, `chain.rs:1228`) |
| `a-kept-body-was-paid-for` | Safety | `Always` each kept fetched body has a line | P0 | **C**: the reads-only 409, a cap refusal or a crash keeps the body with no line, and reuse is free (`api.rs:782-786,673,686`) |
| `no-passed-line-past-the-cap` | Safety | `Always` signed total ≤ cap for the line's epoch | P1 | **S**: a claim or epoch roll mid-call leaves a signed line that can't be paid |
| `one-unpayable-line-never-blocks-the-rest` | Safety at quiescence | `Always` every individually payable line is spent | P1 | **C**: `claim()` sends one all-or-nothing batch; one OverCap line reverts the rest; gas caps a batch at about 135-275 lines |
| `vesting-stays-withdrawable` | Safety | `Always` `withdrawVested` fits the block gas limit | P1 | **C**: walks every entry; 2,500 entries revert at 30M gas |
| `each-line-is-paid-at-most-once` | Safety | `Always` no line paid twice; claimed total ≤ cap and deposit | P2 | **H** |
| `passed-lines-are-claimed-within-their-window` | Liveness | `Always` at window close: covered lines spent | P1 | **S**: no RPC timeouts; own-route lines filed under epoch 0 (`api.rs:839`) |
| `receipt-ledger-never-shrinks` | Safety | `Always` file length ≥ high-water mark; dense indexes | P1 | **C**: an unreadable file reads as empty and is overwritten from index 0, past the cap (`store.rs:60-62`) |
| `body-voucher-releases-one-body` | Safety | `Always` a replayed voucher is refused | P2 | **R**: `SPENT` lives only in memory and names no server (low value) |
| `the-per-fetch-maximum-bounds-the-same-currency-the-fee-is-in` | Safety | `Always` committed USDC ≤ `max_fetch_usdc` | P1 (live) | **S**, narrowed: the owner confirmed the fee is USDC, so the comparison's unit is right. What remains: a fixed 18-decimal scale that is wrong against Arc's 6-decimal USDC, plus places that still call the fee UNB (`chain.rs:946`, `Verified.fee`, the listing's `Price`, `paid_unb`) |
| `a-server-never-releases-a-body-for-less-than-its-current-fee` | Safety | `Always` voucher ≥ the fee read in the same serve | P2 | **H/S**: a reprice can race the read and the pay |
| `auto-pricing-moves-the-fee-once-per-epoch` | Safety | `Always` ≤1 `FeeSet` per contributor per epoch | P2 | **R**: the epoch is saved only after `setFee`; a landed-but-errored write compounds the move (`main.rs:604-610`) |

## B. Shared routes: integrity and what a caller runs

| Slug | Type | Main assertion | Pri | Status |
|---|---|---|---|---|
| `network-write-never-auto-run-for-a-read-intent` | Safety | `AlwaysOrUnreachable` no paid write for a read goal | P0 | **R, fixed on PR #53** (61365f6a): the network path read intent from the goal's first word only |
| `a-state-change-is-never-classified-a-read-by-its-endpoint-name` | Safety | `AlwaysOrUnreachable` the read label isn't contributor-controlled | P1 | **S**: `ledger::writes` uses the method plus the path's last word |
| `a-shared-body-never-reaches-a-host-off-its-site-nor-a-private-address` | Safety | `Always` credentials stay on the route's site; `Unreachable` private hop | P0 | **S**: three host parsers; a re-walk after a heal skips the second `bound` check |
| `a-delisted-or-superseded-route-is-not-run-from-cache` | Safety | `AlwaysOrUnreachable` a cached run's entry is live | P1 | **R**: the cache path does no live check; a delist never reaches caches |
| `caller-runs-only-the-signed-body` | Safety | `Always` body hash == signed content id from the contributor | P0 | **H** |
| `served-body-matches-signed-content-id` | Safety | `Always` at `share.rs:307` | P0 | **H**; open: a crash between `save_body` and `save_route` |
| `delisted-or-underpaid-body-never-released` | Safety | `Always` `e.live && amount >= fee` at release | P1 | **H** for servers; caches as above |
| `lookup-keeps-newest-listing-version` | Safety | `Always` chosen version ≥ newest heard | P2 | **S**: `kept()` keeps the first answer (`node.rs:540`) |
| `entry-dark-only-when-providers-served-nothing` | Safety | `Always` dark ⇒ providers were asked and none served | P2 | **R**: the caller's own RPC or write errors mark an entry dark (`api.rs:757-759`) |

## C. Peer network

| Slug | Type | Main assertion | Pri | Status |
|---|---|---|---|---|
| `nodes-booting-together-find-each-other` | Liveness | `Always` after quiet: every pair in each other's table | P1 | **C** (two agents): seeds are read once at 3 s (`node.rs:562-580`) |
| `admission-recovers-after-registry-stall` | Liveness | `Always` after quiet: registered peers count | P1 | **C**: no timeout; `asking` stays set, so the peer is never re-asked (`node.rs:752-756,1011-1018`) |
| `too-old-peer-never-counts` | Safety | `Always` `standing()` ≠ Counts for a too-old peer | P1 | **C**: reconnecting older under the same key keeps `admitted` (`node.rs:955-960,681-684`); the in-flight race didn't reproduce |
| `listings-answering-survives-a-stuck-answer` | Liveness | `Always` answering < 16 or the oldest is under 15 s | P1 | **C**: 16 stuck answers silence a provider for every site |
| `listings-answer-fits-its-bound` | Safety | `Always` answer ≤ 256 KiB | P1 | **C**: 48 listings of 6 KiB are dropped whole |
| `node-on-network-after-first-publish-fails` | Liveness | `Always` after recovery: lookups and publish work | P1 | **S**: `peers::start` returns `Err` after the swarm started; never retried |
| `checked-lookup-spans-two-identities` | Safety | `Always` checked ⇒ two distinct registered identities | P1 | **H**; inherits the admission defects |
| `two-distinct-identities-is-only-as-strong-as-registration-is-costly` | Safety | `AlwaysOrUnreachable` the sources are economically distinct | P2 | needs human input (registry cost) |
| `table-role-follows-reachability` | Safety | `Always` Kad mode and relay follow reachability | P2 | **H** |
| `light-mode-answers-no-queries-on-any-protocol` | Safety | `Always` light ⇒ no listings and no fetched-body answers | P2 | **S**: only Kademlia goes client-mode; the listings handler stays |

## D. Node lifecycle and concurrency

| Slug | Type | Main assertion | Pri | Status |
|---|---|---|---|---|
| `owner-key-writes-never-share-a-nonce` | Safety | `Unreachable` nonce-refused owner write | P1 | **C**: 10/10 rounds, a fresh provider per write (`chain.rs:574-627`) |
| `one-erc8004-identity-per-owner` | Safety | `Always` ≤1 `Registered(owner)` | P1 | **C**: a lost file or two concurrent `ensure` calls register twice (`erc8004.rs:76-116`) |
| `holding-on-chain-converges-to-held-json` | Safety at quiescence | `Always` chain holds == `held.json` | P1 | **C**: a failed release is cleared anyway (`peers.rs:441-448`); after a crash `AlreadyHolding` |
| `background-pass-completes-after-chain-faults-stop` | Liveness | `Always` now − last pass ≤ Q + 60 s + T | P1 | **C**: no timeout on chain reads; one hang stalls claims for every agent |
| `boot-failures-heal-without-restart` | Liveness | `Sometimes` fully up after a boot-time failure | P1 | **R**: four one-shots (`main.rs:1429-1437`, `chain.rs:408`) |
| `claim-loop-runs-while-off-the-peer-network` | Liveness | `Sometimes` a claim pass ran with the network off | P1 | **R**: the loop is gated on `network_on()` (`main.rs:1416`); opted-out nodes never claim |
| `kept-manifest-pair-never-lowers-min-version` | Safety | `Always` min after restart ≥ max ever kept | P2 | **C**: two plain writes tear; an older release then lowers the minimum (`update.rs:360-369`) |

## Open questions needing human input

These are short versions; full context is in each evidence file.

1. **Booking withheld USDC as UNB at par.** *Answered by the owner on 2026-10-30:* route fees are dynamically priced in USDC, and the bond is UNB. So crediting withheld USDC to a UNB bond 1:1 is a defect wherever this bytecode runs, arc-testnet included, not a devnet simplification. Still open: no pool exists in the repo (the contract's comment at `LeanSettlement.sol:676-677` puts the swap "above this contract"). Which pool should the withheld USDC swap through (R6.8, economy.md:31)?
2. **Serving share:** is a hold record required to earn the 5%, or does R7.3 hold ("a seeder needs no record to serve")? If the hold check is dropped, the payer picks who is paid.
3. **The reads-only 409 after a fetch:** should it bill the use or drop the body?
4. **Delisting:** should it reach bodies other nodes have cached, at least write routes?
5. ~~Fee unit~~ **Answered:** the fee is USDC and is priced dynamically. Still open: how the 18-decimal node scales against a 6-decimal USDC on Arc.
6. **Opted-out nodes:** should a node with `peer_network` off still claim its own-entry lines?
7. **Registry cost:** what does an ERC-8004 identity cost, and is `checked` meant to carry weight on a devnet with no registry?
8. **Superseded listing versions:** are they equal choices (R2.6), or does the newest win (R2.18)?
9. ~~The deck's disk-full update~~ **Resolved.** The deck's update ran through its own hand-written `~/.local/bin/unbrowse` script, not through `update.rs`. That script was made fail-safe on 2026-10-30. One finding remains: `api.rs:899` tells users to run `unbrowse update`, and no such command exists.

## Route coins (11 November 2026)

The bond, vesting, route stakes and server shares are gone, so four properties above are retired and replaced in the
workload (`helper_invariants.py`, after `unbrowse-settlement/test/lean/Invariants.t.sol`):

| Retired | In its place |
|---|---|
| `settlement-unb-covers-every-bond` | `settlement-holds-no-unb`: Settlement holds no UNB at all |
| `vesting-stays-withdrawable` | `the-route-share-stays-withdrawable`: `CoinFetch.withdraw` fits a block for every contributor it owes |
| `serving-share-pays-the-node-that-served` | `only-a-claims-contributors-are-owed`: the fetch owes a claim's route share only to the credited contributor of an entry it paid |
| `holding-on-chain-converges-to-held-json` | none: holding is no longer on chain |

`settlement-usdc-equals-its-liabilities` stands, as deposits + escrow + burn buffer + `heldRoute`, and
`the-fetch-holds-exactly-what-it-owes` (`CoinFetch`'s USDC equals its `accounted`) is new.
