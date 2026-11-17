# Roadmap: designs borrowed from systems that already work

These are lifecycle and design patterns taken from systems that have run at scale for years. Each item names:

- **From:** the system it is borrowed from.
- **Problem:** the gap in Unbrowse today, with a code reference.
- **Design:** the design we will build.
- **Code:** the files it touches.
- **Done when:** the tests that say it is done.
- **Spec:** any rule in [`papers/protocol.md`](../papers/protocol.md) that changes. That copy is the route-coin
  specification, synced from `protocol/spec/` in unbrowse-papers; an item written before it that touches the economy
  must be read against it.

Items are built in three waves. A wave starts after the one it depends on has merged, so two waves never edit the same
files at once.

Already done in the same spirit:

- Offline nodes stop being found within an hour. This follows BitTorrent's BEP 5 expiry, a signed goodbye and
  live-first lookups (branch `offline-nodes`).
- Sites prove their domain with on-chain DNSSEC, using ENS's verifier (#94). Only DNSSEC proves a domain (item 8).

| # | Item | From | Wave |
|---|---|---|---|
| 1 | [Watchtowers for unclaimed lines](#1-watchtowers-for-unclaimed-lines) | Lightning | A |
| 2 | [Signed updates that can rotate keys and can't be frozen](#2-signed-updates-that-can-rotate-keys-and-cant-be-frozen) | TUF, Sigstore | A |
| 3 | [Per-peer budgets and serving slots](#3-per-peer-budgets-and-serving-slots) | Token buckets, BitTorrent choking | B |
| 4 | [Finality before a write counts](#4-finality-before-a-write-counts) | Exchanges, bridges | A |
| 5 | [Delists and reprices spread by gossip](#5-delists-and-reprices-spread-by-gossip) | libp2p gossipsub (Ethereum, IPFS) | B |
| 6 | [A bounded body store](#6-a-bounded-body-store) | IPFS pinning and garbage collection | B |
| 7 | [Reputation from paid, passed uses](#7-reputation-from-paid-passed-uses) | EigenTrust, PageRank | C |
| 8 | [A second way to prove a domain](#8-a-second-way-to-prove-a-domain) | ACME HTTP-01 | C |
| 9 | [Versioned files and protocols](#9-versioned-files-and-protocols) | Database migrations, multistream versioning | C |
| 10 | [Readiness and staged rollouts](#10-readiness-and-staged-rollouts) | Kubernetes probes, canary channels | A |

---

## 1. Watchtowers for unclaimed lines

**Status: built** (branch `watchtower`). Tests: `watchtower::tests::a_watchtower_claims_what_a_stopped_payer_left_before_the_window_closes`, `crates/net/tests/towers.rs`, and the landing `test/tower.test.mjs`.

- **From:** Lightning watchtowers. These act for a party who is offline, using material that party handed over in
  advance.
- **Problem:**
  - A voucher for epoch e can be claimed only through e + `CLAIM_WINDOW` (1), as set in `LeanSettlement.sol`.
  - Receipts live on the payer's machine and never reach another machine (see `docs/NETWORK.md` §13).
  - So if the payer's node is off for two epochs, the contributor, the site and the server lose those lines.
- **Design:**
  - A claim is authorised by the payer agent's signature on the voucher, not by `msg.sender`. Anyone holding the
    signed voucher and its lines can submit it, and the money still goes to the payees.
  - A node hands each closed epoch's signed vouchers and lines to one or more watchtowers.
  - A watchtower claims whatever is still unclaimed when the window is about to close, and does nothing otherwise.
  - Every node can act as a watchtower for its peers, and holds what it was handed in a bounded store.
  - The site's own tower is the default watchtower. It pays the gas from its own wallet only in that last stretch
    before the window closes.
  - A line's payee claims first and the payer's own node is the backstop (`chain::backstop_due`). The watchtower comes last.
  - A watchtower can only cause a claim to be made. It can't redirect a payment or change a line, because the
    contract checks the signatures and pays the lines' own payees.
- **Code:**
  - `chain/`: export and import of a stream's signed vouchers and lines.
  - New `watchtower.rs`: hold, schedule and claim.
  - A new request-response protocol, `/unbrowse/tower/1`.
  - The landing site gets a `/tower/v1` endpoint.
- **Done when:**
  - On Anvil, the payer's node is stopped after its calls, and its lines are claimed by a watchtower before the window
    closes, with the payees paid.
  - A watchtower given a tampered line is refused by the contract.
  - A line the payer already claimed is not claimed twice.
- **Spec:** R3.28 gains a sentence: any node MAY submit a payer-signed voucher on its behalf.

## 2. Signed updates that can rotate keys and can't be frozen

- **From:** TUF (The Update Framework) and Sigstore. Signing roles are kept separate, keys can rotate, and metadata
  expires, so a mirror can't freeze clients on an old version or roll them back.
- **Problem:**
  - `update.rs` checks one signed manifest against one embedded key, plus `min_version`.
  - There is no key rotation and no expiry, so a stale mirror can hold nodes on an old release forever.
  - Self-update via npm is broken: every 13.x publish has 404'd, so npm still serves 12.5.0 (see `docs/OPERATIONS.md`
    §10).
- **Design:**
  - Use a TUF-shaped metadata set: root (keys and thresholds, rotatable by a quorum of the old root), targets
    (versions and hashes), and timestamp (a short-lived signature on the latest snapshot, which defeats freeze attacks).
  - Old roots chain to new ones, so a node can follow a key rotation.
  - Fix the npm publish: the `@unbrowse/*` packages and trusted publishing.
  - Add the `unbrowse restart` and `unbrowse update` commands that the node already tells people to run.
- **Code:** `update.rs`, `.github/workflows/release.yml`, `unbrowse-sdk/typescript/src/cli.ts`, and the release
  scripts.
- **Done when:**
  - A node refuses expired timestamp metadata.
  - It follows a rotated root.
  - It refuses a rollback.
  - A 13.x release reaches npm.
  - `unbrowse update` and `unbrowse restart` exist and work.
- **Spec:** none. The update path is off-chain.
- **Status: built** (branch `signed-updates`). `update.rs` checks root, targets and timestamp from `@unbrowse/updates`,
  written by `.github/scripts/updates.mjs`; `unbrowse update` and `unbrowse restart` are `update_now` and `restart`.
  Tests: `expired_timestamp_metadata_is_refused`, `a_rotated_root_is_followed`, `rolled_back_metadata_is_refused`,
  `a_newer_release_is_fetched_checked_and_unpacked` (a channel moved back isn't followed) and
  `the_node_reads_the_metadata_the_release_script_signs` in `update.rs`; `.github/scripts/test/updates.test.mjs`; the
  launchers' routing in `cli.test.mjs` and `test_cli.py`. A 13.x release reaches npm once the owner does the npm steps
  in [OPERATIONS.md §10](OPERATIONS.md#10-known-gaps): the workflow side is fixed.

## 3. Per-peer budgets and serving slots

- **From:** token-bucket rate limiting, and BitTorrent's choking. BitTorrent uploads to a few peers at once, prefers
  the ones that reciprocate, and gives a random newcomer a turn.
- **Problem:**
  - Listings answers share 16 slots across all peers.
  - Body requests are limited per peer.
  - Kademlia provider lookups have no limit.
  - R7.18 and R7.26 ask for per-peer rate limits, and they are only partly built (see `docs/SPEC-STATUS.md`).
- **Design:**
  - Give each admitted peer a token bucket per protocol: listings, bodies, and Kademlia queries the node answers.
  - Serving slots go first to peers that pay for bodies. One slot is kept for a newcomer, rotated now and then, as in
    BitTorrent's optimistic unchoke.
  - A peer over its budget gets a fast refusal, not a timeout.
- **Code:** `crates/net` (`node.rs`, `body.rs`, the listings handler) and `peers.rs`.
- **Done when:**
  - One peer flooding listings asks can't stop another peer's answers.
  - A paying peer is served ahead of a non-paying one when slots are full.
  - A newcomer still gets served.
- **Spec:** R7.18 and R7.26 become built. Annex A gains the bucket sizes.
- **Status: built** (branch `net-budgets`). `crates/net/src/budget.rs`: `Budget` (a token bucket per peer and protocol,
  with strangers sharing one more), `Slots` (16 at a time, a free one to the waiting peer that paid most, one kept for
  a newcomer and rotated every answer), `Payers` (bodies paid for within the hour) and `KadGate` with `Gated`, which
  closes a Kademlia stream past its peer's budget before Kademlia reads it. A listings refusal is
  `{"refused": "<why>"}`. Tests in `crates/net/tests/budgets.rs`:
  `one_peer_flooding_listings_asks_cannot_stop_another_peers_answers`,
  `a_paying_peer_is_served_ahead_of_a_non_paying_one_when_slots_are_full`, `a_newcomer_still_gets_served` and
  `a_peer_flooding_table_queries_is_refused_at_once_and_others_are_answered`. The sizes are in Annex A and
  [NETWORK.md §5a](NETWORK.md#5a-budgets-and-serving-slots).

## 4. Finality before a write counts

- **From:** exchanges and bridges. They treat a deposit as done only after enough confirmations, and re-check after a
  reorg.
- **Problem:**
  - The node counts a transaction as done when its receipt arrives (`rpc::mined!`).
  - There is no confirmation depth and no reorg handling.
- **Design:**
  - Find out what Arc guarantees: deterministic finality, its depth, and whether `eth_getBlockByNumber("finalized")` is
    served.
  - If finality is instant, record that, test it, and keep a cheap check.
  - Otherwise, a write that moves money counts only once its block is finalized: a claim, a deposit, a withdrawal, a
    coin trade, a stake, or a listing.
  - Local state that followed it (receipt marks, `held.json`, autolist and pricing records) is re-checked after a
    reorg.
- **Code:** `rpc.rs`, `chain/` (the claim marks and deposits), `peers.rs` (holds) and `autolist.rs`.
- **Done when:**
  - On Anvil with a forced reorg, a claim whose block was dropped is claimed again, and isn't marked paid.
  - A finalized write is never re-sent.
- **Spec:** an informative note under R3.22 or wherever claims are settled.
- **Status: built** (branch `finality`). Arc's finality is deterministic and instant: its docs say a block is final
  once more than two thirds of its validators sign it, with no reorgs, and on 31 October 2026 both Arc RPCs served
  `finalized` and `safe` at the head or one block behind it. So every write the node sends counts once its block is
  final (`rpc::finalized`, run inside `mined!`), which on Arc is a read or two after the receipt. Reads that decide a
  write already happened (a spent line, a hold) are made at the final block (`rpc::SETTLED`). The devnet's Anvil
  finalizes each block as it makes it, as Arc does. Tests: `a_claim_a_reorg_dropped_is_claimed_again_and_a_final_one_never_again`
  (`app/src/chain/`, Anvil with a forced reorg) and `arc_blocks_are_final_as_they_are_made` (`app/src/arc.rs`, Arc's
  RPCs, read only). The note is under R3.24.

## 5. Delists and reprices spread by gossip

- **From:** libp2p gossipsub, as Ethereum and IPFS use it. Changes reach subscribers in seconds.
- **Problem:**
  - A delist or a reprice reaches the nodes holding a kept copy only when they next read the chain: every 10 minutes
    for read routes (`share::LIVE_FOR`), and every call for write routes.
  - A body's holders and a site's seekers learn nothing until then.
- **Design:**
  - Each registrable site has a gossipsub topic.
  - A contributor's node publishes a signed `delisted` or `repriced` message when it changes an entry on chain.
  - Nodes that hold a kept copy or serve the site subscribe, and re-check the chain at once when a message names one
    of their entries.
  - The chain stays the truth: a message only triggers a re-read, and never changes anything on its own.
  - Messages from unadmitted peers are dropped, and the topic score uses gossipsub's own peer scoring.
- **Code:** `crates/net` (a gossipsub behaviour, topics, admission), `share.rs` (re-check on message), and `api.rs` and
  `main.rs` (publish on delist and reprice).
- **Done when:**
  - In the five-node test, a delist stops a kept copy on another node within seconds, not 10 minutes.
  - A forged or unadmitted message changes nothing.
- **Spec:** R7.x gains a rule for change notices, which are advisory, with the chain authoritative.
- **Status: built** (branch `net-budgets`). `crates/net/src/changes.rs` (`Change`, a topic a site, gossipsub on
  `/unbrowse/changes/1.1.0` with strict signing and validation, and its peer scoring), `Net::watch`,
  `Net::publish_change` and `Net::changes`; `share::watched_sites`, `share::watch`, `share::announce` (from
  `delist_route`, `set_pricing` and `reprice`) and `share::on_change`. The scoring keeps gossipsub's own peer scoring
  and tunes it for a quiet topic: the mesh delivery rate (P3, P3b) and IP colocation (P6) are off, one invalid notice
  (P4, −100) or a refusal by the registry (P5, −1000) is below the graylist, and time in the mesh and first deliveries
  (P1, P2) earn at most +10 each; [NETWORK.md §15](NETWORK.md#15-change-notices) gives every value and why. The rule
  is R7.28. Tests: `a_change_notice_reaches_a_node_watching_the_site_within_seconds` and
  `a_forged_or_unadmitted_notice_never_reaches_the_node` (`crates/net/tests/changes.rs`), and the five-node test,
  where a notice for an entry still live leaves the kept copy running and the delist drops it within a second.

## 6. A bounded body store

- **From:** IPFS pinning and garbage collection. The cache is bounded, least-recently-used items are evicted, pinned
  items are kept, and a node announces only what it would actually serve.
- **Problem:**
  - `storage_gb` only bounds held routes (`peers::max_held`).
  - Fetched and seeded bodies under `~/.unbrowse` have no bound and no eviction.
  - The node announces every body it kept, whether or not it would serve it.
- **Design:**
  - The body store is bounded by `storage_gb`.
  - Bodies are pinned when they are the node's own routes or a route its agents used within a window.
  - Unpinned bodies are evicted least-recently-used first, and withdrawn from the table (`stop_providing_body`) when
    evicted.
  - The node announces only bodies it would serve: not in light mode, not set aside.
- **Code:** `share.rs`, `recipe.rs` (the body files), `store.rs` (the size accounting) and `peers.rs`.
- **Done when:**
  - Filling the store past `storage_gb` evicts the least recently used unpinned body and stops providing it.
  - Pinned bodies survive.
  - A restart keeps the accounting right.
- **Spec:** an informative note under R7.18.
- **Status: built** (branch `bounded-store`). `share::trim`, `share::body_store`, `store::over_bound`,
  `store::body_bound`, `recipe::kept_bodies` and `recipe::used_body`; `share::provide` and `provide_all` announce only
  bodies on disk and not set aside. Pinned: every body the node lists, and a body a route made from it was called or
  fetched within 7 days (`PINNED_FOR`). Tests in `app/src/share.rs`:
  `a_full_store_lets_go_of_the_least_recently_used_unpinned_body_and_stops_providing_it`,
  `a_restart_keeps_the_store_accounting_right` and `a_node_announces_only_bodies_it_would_serve`.

## 7. Reputation from paid, passed uses

- **From:** EigenTrust and PageRank. Trust is weighted by who vouches, so votes from sybils count for little.
- **Problem:**
  - Almost all of §5 (ratings, reputation, the default entry, exploration, canaries) is unbuilt.
  - A network entry is picked by matching words and the lowest fee (see `docs/SPEC-STATUS.md`, chapter 5).
- **Design:**
  - An entry's score comes from claimed, passed lines on chain, weighted by the payer's own standing (R5.3); a payer
    an audit links to the contributor gives no switch evidence (R5.18).
  - Failure reports count only from payers verified as persons (R1.33).
  - The default entry for an intent is its earliest listing until a challenger wins the sequential test (R5.17); an
    entry under 30 counted uses is tagged unverified (R3.36, `ranking.unverified_uses`), which is no floor on the
    default.
  - A small share of picks explores unverified entries.
  - Canaries are the platform's disclosed test calls (R1.10).
  - Every node computes scores locally from chain events. No node is trusted for them.
- **Code:** new `rank.rs` work (there is a `rank.rs` today), `api.rs` (picking), chain event reads, and the UI
  (showing every live entry, R3.36).
- **Done when:**
  - Given scripted chain histories, the default entry follows passed, independent use.
  - A sybil ring paying itself doesn't move it.
  - Unverified entries still get explored.
- **Spec:** §5 rules move from not built to built, with the score formula written into the spec where §5 leaves it
  OPEN.
- **Status: built** (branch `reputation`). `rank/reputation.rs` (`standings`, `order`, `beats`, `demote`), read from the
  chain by `chain::reputation_history` up to the finalized block and used by `api/goal.rs` `network_goal` (the pick) and
  `merged` (search). A payer is linked to a contributor that reaches it in 2 hops of the payment graph: claimed lines,
  USDC sent between Settlement's wallets, and agent keys. Standing is earned only by paying strangers. Failures count
  only through the `Personhood` hook, which verifies nobody yet. Canaries are checked against the operator's
  commitment once Settlement records them. Search answers carry `reputation`, and the owner command `entries` feeds
  "Routes on the network" on the window's Leaderboard. Formula and parameters are in
  [SHARING.md §7](SHARING.md#7-which-entry-is-picked-reputation-from-paid-passed-uses). Tests in `rank/reputation.rs`:
  `the_default_follows_passed_independent_use`, `a_sybil_ring_paying_itself_does_not_move_the_default` and
  `unverified_entries_still_get_explored`, with the Anvil test `the_chain_shows_each_use_key_and_send_reputation_reads`
  in `chain/`.

## 8. A second way to prove a domain

- **From:** ACME (Let's Encrypt's HTTP-01 check).
- **Status: removed** by the owner on 11 November 2026. It was built on 1 November (branch `domain-proof`) as proof by
  nodes that fetched a file from the site over HTTPS; the contract path, the node's duty, its setting and its
  commands are gone. A domain is proven by DNSSEC only (R4.14, `Domains.claimEscrow`). A domain without DNSSEC can't
  be proven: its site share waits in escrow until it has DNSSEC and a proof is submitted.
- What stayed from the branch: `Domains.sol` as the home of the DNSSEC proof, the escrow's release and the site policy
  (R4.17), and the policy the node honours (`sitepolicy.rs`): an entry under the floor is refused, saying the floor; a
  delisted site's routes leave the live set; declared hosts are the site's own (R2.27 (b)); each site's policy is read
  at most once an epoch. Tests: `sitepolicy.rs` `a_policy_refuses_entries_under_its_floor_and_every_entry_once_delisted`,
  `a_declared_host_counts_only_exactly_and_under_its_path` and `a_policy_is_read_at_most_once_an_epoch`; `share.rs`
  `a_host_the_sites_policy_declares_may_take_the_session`; and in `Settlement.t.sol` `test_escrow_*`,
  `test_domains_*` and `DomainsInvariants.t.sol`.

## 9. Versioned files and protocols

- **From:** database migrations, and libp2p multistream versioning.
- **Problem:**
  - On-disk files (settings, agents, receipts, the peer table, held routes, the kept manifest) carry no format version
    and rely on lenient parsing.
  - Wire protocols are versioned by name (`/unbrowse/body/1`), with no plan for a version 2.
- **Design:**
  - Every file the node writes carries `"v": n`.
  - Readers migrate older versions forward, one way, and refuse newer ones with a clear message.
  - A node speaks the old and the new protocol side by side for one release whenever a protocol changes, and drops
    the old one the release after.
- **Code:** `store.rs` and every reader of a file, and the `crates/net` protocol registration.
- **Done when:**
  - Every file has a version.
  - Old fixtures read through the migrations.
  - A newer file is refused cleanly.
  - Two nodes one protocol version apart still talk.
- **Spec:** an informative note in §0 (conventions).
- **Status: built** (branch `versioning`).
  - Files: a crate, `unbrowse-files` (`crates/files`), lists every file the node writes as one entry in `ALL`: its
    version, its shape (named fields carry `v` beside them; lists and maps keyed by others' names are wrapped as
    `{"v": n, "items": ...}`) and its steps forward (`Format::steps`; a file from before versions is version 0 and reads
    as version 1). There are 38 formats, each at version 1, and the formats of `set-aside.json` and `dark-entries.json`
    keep their `{"v": 1, ...}`. Every reader goes through `store::read_json`, `read_json_strict`, `read_json_opt`
    or `Format::read`, and every writer through `store::write_json` or `Format::writable`, which refuses to write over a
    file a newer node wrote. Settings a newer node wrote stop the node from starting (`store::settings_readable`).
    Before a file is read forward, its old bytes are kept beside it as `<name>.v<old>`, once, atomically and with its
    permissions, and every write checks for that copy first (`unbrowse_files::kept_original`), so a build from before
    versions that empties a list can be undone by hand (OPERATIONS.md §7). Tests
    `a_file_read_forward_keeps_its_old_bytes_beside_it_once` and `a_write_over_an_older_file_keeps_it_first`.
    Left out, because their contents fix their form: route bodies (their bytes are their name), kept answers, and
    one-value text files (tokens, keys, `versions/current`). Each format has a fixture of the oldest form a node wrote
    it in (`crates/files/fixtures`). Tests: in `app/src/formats.rs`,
    `every_file_reads_from_its_oldest_form_and_is_written_back_with_its_version`,
    `a_file_a_newer_node_wrote_is_refused_and_never_written_over` and
    `the_nodes_readers_take_old_files_and_refuse_newer_ones`; in `crates/files`,
    `an_older_file_reads_through_every_step_forward`, `a_newer_file_is_refused_and_never_written_over` and
    `every_format_has_a_version_and_an_old_fixture_that_reads`; in `crates/net`,
    `a_peer_table_from_before_reads_and_a_newer_one_is_left_alone` and `a_set_aside_file_as_first_written_still_reads`.
  - Protocols: `crates/net/src/wire.rs`. `Config::speaks` (this release's `wire::THIS_RELEASE`, version 1 of each)
    registers Hello, Listings, Body, Tower and Leaving under every version spoken, newest first, so multistream-select
    settles on the newest both ends speak. Change notices carry their version in the topic (`changes::topic_of`); a node
    speaking two watches and publishes on both. Kademlia (one name in libp2p) and Identify's said-only version stay
    single. Tests in `crates/net/tests/versions.rs`: `the_release_that_changes_a_protocol_talks_to_the_release_before`,
    `the_release_after_a_change_talks_to_the_release_that_made_it`, `two_releases_apart_do_not_talk` and
    `a_node_that_speaks_no_version_of_a_protocol_does_not_start`.

## 10. Readiness and staged rollouts

- **From:** Kubernetes readiness and liveness probes, and canary update channels.
- **Problem:**
  - A release reaches every node at once.
  - The only brake is `min_version`.
  - A node starts serving before its chain, keys and network are ready.
- **Design:**
  - A `/v1/health` endpoint reports two things separately: whether the node is alive and whether it is ready (chain,
    Settlement, keys, network, identity).
  - The node doesn't announce or serve until it is ready.
  - Releases go to channels (`canary`, then `stable`). A node picks its channel, or is assigned one by a stable hash of
    its identity, so a percentage rollout needs no server.
  - The rollout can pause on a signed halt in the update metadata (item 2).
- **Code:** `api.rs` (health), `main.rs` (gating announce and serve), `update.rs` (channels), `release.yml`.
- **Done when:**
  - A node with no Settlement reports alive but not ready, and doesn't serve.
  - A canary release reaches only canary nodes.
  - A halt stops the rollout.
- **Spec:** none.
- **Status: built** (branch `signed-updates`). `GET /v1/health` (`health.rs`), the join gate in `main.rs`
  `join_peers` (`health::to_join`), channels and the halt in `update.rs` (`choose`, `bucket`), `updates.yml`.
  Tests: `a_node_with_no_settlement_is_alive_but_not_ready_and_does_not_serve` (Anvil) and
  `a_node_whose_chain_has_not_started_is_alive_but_not_ready` in `health.rs`; `a_canary_release_reaches_only_canary_nodes`,
  `a_canary_share_picks_the_same_nodes_and_about_that_many` and `a_halt_stops_the_rollout` in `update.rs`.

---

## Order

- **Wave A**, starting now: items 1, 2 and 10 (one engineer for 2 and 10 together), and 4.
- **Wave B**, after `offline-nodes` merges: items 3, 5 and 6. All three touch `crates/net` and `share.rs`.
- **Wave C**, after wave B: items 7, 8 (its design signed off on 2026-11-01) and 9. Item 9 touches every file the
  node writes, so it goes last.

Each item lands as its own PR. Its tests come from its "Done when", and it updates this page's status as it lands.
