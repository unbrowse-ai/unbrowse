# Testing

Every test suite in the repository, how to run it, what it needs, and what CI runs. Then the Antithesis harness, and
the tests known to be flaky. Commands are run from the repository root unless a directory is named.

Nothing here touches a live chain or real funds. Chain tests start their own local Anvil. The gas scripts and the few
tests that fork Arc testnet only read code and state from its public RPC; every transaction goes to the local fork.

- [1. At a glance](#1-at-a-glance)
- [2. The cargo workspaces](#2-the-cargo-workspaces)
- [3. The ignored tests](#3-the-ignored-tests)
- [4. The contracts (forge)](#4-the-contracts-forge)
- [5. The SDKs](#5-the-sdks)
- [6. The window](#6-the-window)
- [7. The workers and the rest](#7-the-workers-and-the-rest)
- [8. The Antithesis harness](#8-the-antithesis-harness)
- [9. Flaky tests](#9-flaky-tests)

---

## 1. At a glance

Measured on 30 October 2026 on an Apple-silicon Mac, unless a row says otherwise. The machine was busy with other
builds, so wall times run high.

| Suite | Where | Command | Result | In CI |
|---|---|---|---|---|
| The node | `unbrowse-node/` | `cargo test --workspace --locked` | 655 passed, 39 ignored on 31 October (after roadmap item 9 and the merge of #112) | `node` job, macOS |
| The node's ignored tests | `unbrowse-node/` | one per process (§3) | the ones run passed | no |
| The browser engine | `unbrowse-browser/core`, `unbrowse-browser/cli` | `cargo test --locked` | not run here | `engine` job |
| The contracts | `unbrowse-settlement/` | `forge test` | 312 passed in 10 suites; 14 min 15 s | `settlement` job |
| Gas | `unbrowse-settlement/script/gas/` | three scripts (§4) | all exit 0 | no |
| TypeScript SDK | `unbrowse-sdk/typescript/` | `npm ci && npm test` | 48 passed | `sdk-typescript` |
| Python SDK | `unbrowse-sdk/python/` | `python -m unittest discover -s tests -v` | 34 passed | `sdk-python` (3.9, 3.13) |
| The native window | `unbrowse-node/window/` | `zig build test && zig build` | not run here: no Zig 0.17.0 | `window`; `elsewhere` builds it |
| Telemetry worker | `unbrowse-telemetry/` | `node --test test/*.test.mjs` | 9 passed | `telemetry` |
| Landing worker | the unbrowse-landing repository | `npm test` | 41 passed, the Anvil ones included (31 October 2026, the watchtower's included) | not here |
| Test bank | `test-banks/popular-sites/` | `python3 -m unittest discover -s test-banks/popular-sites -p 'test_*.py'` | 16 passed | no |
| QA by an agent | `.github/qa/checklist.md` | `qa.yml` | needs a Claude secret | nightly on staging, and by hand |
| Antithesis | `antithesis/` | §8 | setup and every command passed once, locally | no |

---

## 2. The cargo workspaces

**The node** ([`unbrowse-node/Cargo.toml`](../unbrowse-node/Cargo.toml)) is one workspace of five crates. It patches
`btls-sys` from `vendor/btls-sys`, which isn't committed: `sh scripts/apply-tls-patch.sh` makes it, and needs the
network the first time.

```sh
cd unbrowse-node
sh scripts/apply-tls-patch.sh            # once
cargo test --workspace --locked
cargo test -p unbrowse-node-app <filter> # one crate, a name filter
```

| Crate | Package | Tests in `src/` | `tests/` | Result |
|---|---|---:|---|---|
| `crates/core` | `unbrowse-core` | 21 | `keychain.rs` (1, ignored) | 20 passed, 1 ignored |
| `crates/learn` | `unbrowse-learn` | 190 | `learn_shop.rs` (3), `replay_shop.rs` (4) | 188 passed, 2 ignored; the shop tests 3 and 4 |
| `crates/files` | `unbrowse-files` | 7 | | all passed; its fixtures (`fixtures/`) are read through the node's own types in `app/src/formats.rs` |
| `crates/net` | `unbrowse-net` | 41 | `bodies.rs` (3), `budgets.rs` (4), `changes.rs` (2), `liveness.rs` (10), `network.rs` (2), `offline.rs` (8, 1 ignored), `towers.rs` (1), `versions.rs` (4: two releases one protocol version apart talk, two apart don't) | all passed |
| `app` | `unbrowse-node-app` (bins `unbrowse-node`, `unb`) | 385 | `cli_import.rs` (3), `cli_wallet.rs` (5) | 347 passed and 34 ignored in `unbrowse-node` (the file formats' in `formats.rs`), 4 in `unb`, and the 8 CLI tests (31 October, after roadmap item 9 and the merge of `main` at `6c4f7aae`) |

`learn_shop` and `replay_shop` drive the real browser. They find it at `UNBROWSE_BROWSER`, else
`unbrowse-browser/cli/target/debug/agent-browser` (`crates/learn/tests/common/agent.rs`), and fail without it rather
than skip. Build it first, as CI's `node` job does:

```sh
cd unbrowse-browser/cli && cargo build --locked && ./target/debug/agent-browser install
```

Building one crate after a `--workspace` build recompiles the app, because the two resolve features differently.

**The browser engine** is two separate projects with no workspace: `unbrowse-browser/core` (`agent-browser-core`) and
`unbrowse-browser/cli` (`agent-browser`). Each is `cargo test --locked` in its own directory. CI runs four of the CLI's
tests on their own with `--test-threads=1` (§9). The CLI's 146 end-to-end tests are ignored; they share Chrome, so run
them one at a time: `cargo test e2e -- --ignored --test-threads=1` (`cli/src/native/e2e_tests.rs`). The engine's own
guide is [`unbrowse-browser/AGENTS.md`](../unbrowse-browser/AGENTS.md); its test counts there are out of date.

---

## 3. The ignored tests

Thirty-five tests in the node's workspace are `#[ignore]`: they need Anvil, DNS, the network, a browser, the machine's
real keystore, or its real learned routes. CI runs none of them.

**Run them one per process**, one exact name per `cargo test`:

```sh
cd unbrowse-node
for t in claim_gas_is_a_call_plus_its_lines signing_in_takes_a_local_node_onto_the_network; do
  cargo test -p unbrowse-node-app --locked "$t" -- --ignored --nocapture
done
```

Why: the chain a node reads is the process's (`UNBROWSE_DEVNET_PORT`, `UNBROWSE_CHAIN`, `UNBROWSE_RPC`,
`UNBROWSE_HOME`, `UNBROWSE_NETWORK_DIR`, and statics such as `chain::LIVE`). Tests that set it take
`testchain::one_at_a_time()`, but not all of them do, some set variables they never unset, and several use fixed ports
(below). A filter such as `peers` or `share` is a substring and runs several tests at once: run together, the `peers`
tests failed with OpenZeppelin's `OwnableUnauthorizedAccount` from the USDC faucet, and the same test passed alone.
No script loops over them. "Anvil" means `~/.foundry/bin/anvil` (`testchain.rs`): install Foundry with `foundryup`.

| Test | Where | Needs | Port |
|---|---|---|---|
| `claim_gas_is_a_call_plus_its_lines` | `app/src/chain/tests.rs` | Anvil | free |
| `claims_wait_until_worth_it_and_no_line_outlives_its_window` | `app/src/chain/tests.rs` | Anvil | free |
| `a_claim_a_reorg_dropped_is_claimed_again_and_a_final_one_never_again` | `app/src/chain/tests.rs` | Anvil, its finalized block two behind its head (`UNBROWSE_DEVNET_EPOCH_SLOTS=1`, set by the test), forced reorgs (`anvil_reorg`) | free |
| `pays_and_claims_on_a_local_chain` | `app/src/chain/tests.rs` | Anvil; forks Arc testnet unless `UNBROWSE_DEVNET_FORK=none` | 8599 |
| `pays_and_claims_on_a_local_chain_with_a_6_decimal_usdc` | `app/src/chain/tests.rs` | the same | 8598 |
| `usdc_the_owner_sends_the_wallet_becomes_the_deposit_up_to_the_floor` | `app/src/chain/tests.rs` | Anvil | free |
| `the_chain_shows_each_use_key_and_send_reputation_reads` | `app/src/chain/tests.rs` | Anvil, with `UNBROWSE_DEVNET_FORK=none` (set by the test) | free |
| `a_top_up_on_the_networks_own_usdc_keeps_its_gas_and_deposits_the_rest` | `app/src/chain/tests.rs` | Anvil | free |
| `a_live_network_runs_on_the_contracts_its_file_records` | `app/src/chain/tests.rs` | two Anvils | 8594, 8595 |
| `a_chain_the_node_did_not_start_is_never_taken_for_its_devnet` | `app/src/chain/tests.rs` | Anvil, with `UNBROWSE_DEVNET_FORK=none` | 8597 |
| `a_new_devnet_forks_arc_testnet` | `app/src/chain/tests.rs` | Anvil and Arc testnet's RPC, read only | 8597 |
| `a_node_starts_on_arc_testnet` | `app/src/chain/tests.rs` | Arc testnet's RPC, read only | |
| `the_table_matches_the_live_chains` | `app/src/arc.rs` | every Arc RPC, read only | |
| `arc_blocks_are_final_as_they_are_made` | `app/src/arc.rs` | every Arc RPC, read only | |
| `signing_in_takes_a_local_node_onto_the_network` | `app/src/link.rs` | Anvil | free |
| `a_batch_is_one_transaction_where_multicall3from_runs` | `app/src/rpc.rs` | Anvil | free |
| `a_node_with_no_settlement_is_alive_but_not_ready_and_does_not_serve` | `app/src/health.rs` | Anvil | free |
| `one_erc8004_identity_per_owner` | `app/src/erc8004.rs` | Anvil and a stand-in registry | free |
| `node_on_network_after_first_publish_fails` | `app/src/peers.rs` | the same | free |
| `holding_on_chain_converges_to_held_json` | `app/src/peers.rs` | Anvil | free |
| `a_node_finds_another_nodes_route_by_naming_its_site` | `app/src/peers.rs` | Anvil forking Arc testnet | 8598 |
| `the_node_lists_what_it_uses_within_its_cap_on_a_local_chain` | `app/src/autolist.rs` | Anvil | free |
| `a_delisted_entrys_kept_body_stops_running_within_the_bound` | `app/src/share.rs` | Anvil | free |
| `the_nodes_own_listed_route_is_free_to_its_own_agents` | `app/src/share.rs` | Anvil | free |
| `a_kept_route_that_writes_never_runs_while_the_chain_cant_be_read` | `app/src/share.rs` | Anvil and a relay it cuts | free |
| `a_route_body_travels_between_nodes_and_runs_on_the_caller` | `app/src/share.rs` | Anvil and DNS for `localtest.me` | 8597 |
| `a_watchtower_claims_what_a_stopped_payer_left_before_the_window_closes` | `app/src/watchtower.rs` | Anvil | 8593 |
| `the_node_honours_a_sites_policy_from_the_chain` | `app/src/sitepolicy.rs` | Anvil, with `UNBROWSE_DEVNET_FORK=none` (set by the test): a DNSSEC proof's result written into `Domains` (the devnet's verifier trusts the IANA root only), its owner's policy set on `Domains` and read by `sitepolicy.rs` | free |
| `owner_key_writes_never_share_a_nonce` | `app/src/rpc.rs` | Anvil | free |
| `background_pass_completes_after_chain_faults_stop` | `app/src/rpc.rs` | Anvil | free |
| `boot_failures_heal_without_restart` | `app/src/rpc.rs` | Anvil and a relay | free |
| `a_socket_never_follows_a_public_name_inside` | `app/src/socket.rs` | DNS | |
| `the_node_s_clients_refuse_a_name_pointed_inside` | `crates/learn/src/egress.rs` | DNS | |
| `someone_elses_route_reaches_a_public_https_host` | `crates/learn/src/egress.rs` | the internet | |
| `learns_and_calls_a_real_route`, `learns_the_goal_without_a_human` | `app/src/main.rs` | the internet and Chrome | |
| `measure_false_positives` | `app/src/leak.rs` | a node's real routes and bodies and the test banks (`UNBROWSE_MEASURE_ROUTES`, `_BODIES`, `_BANKS`); prints counts and shapes, never a value: the detector README's rates | |
| `drive_route_with_a_synthetic_credential` | `app/src/leak.rs` | `UNBROWSE_DRIVE_ROUTE`: writes a route record holding a made-up credential, for a devnet drive of the leak path | |
| `pick_from_a_recorded_walk` | `app/src/learn.rs` | `UNBROWSE_WALK`, `UNBROWSE_URL`, `UNBROWSE_GOAL`; returns at once without them | |
| `reports_this_machines_keystore_round_trip` | `crates/core/src/keystore.rs` | the machine's real keystore | |
| `root_key_survives_a_restart_in_the_keychain` | `crates/core/tests/keychain.rs` | writes to the user's Keychain | |

The fixed ports also collide with the gas scripts (8597, 8598, 8599 by default; each takes `PORT=`). And
`a_live_network_runs_on_the_contracts_its_file_records` kills its two Anvils only at its end, so a failed run leaves
them on 8594 and 8595 and the next run fails. Stop them first (`pkill -f 'anvil.*859[45]'`).

Two of them print what they measure:

- `claim_gas_is_a_call_plus_its_lines` claims 1 to 40 lines on one entry with a coin, then 10 lines on ten entries,
  and prints each receipt's gas beside the claim model (`chain::CLAIM_GAS`). It fails if a claim takes more than the
  model, or the model drifts far above it. On 12 November 2026, on the route-coin contracts, each claim buying the
  coin for its payer: 474,056 gas for one line (model 500,000), 2,889,087 for 40 (model 3,230,000), and 3,505,067 for
  10 lines on ten entries (model 3,605,000). It prints every shape before judging any.
- `signing_in_takes_a_local_node_onto_the_network` runs a node that is local (it joins nothing and grants nothing on
  the chain), signs its owner in with a wallet of the test's own, and checks it may then join and that its first agent
  key is granted on the chain.

---

## 4. The contracts (forge)

The suites, the invariants and the 6-decimal runs are described in the
contracts reference (private repository) §8 and §9.

```sh
cd unbrowse-settlement
forge test                                    # every suite: 827 tests in 71 suites (2 skipped without an Arc RPC)
forge test --match-path 'test/lean/*'         # Settlement, the listings, the domain proofs, the pool
forge test --match-path 'test/coins/*'        # the route-coin contracts, their model and its replayed traces
forge test --match-contract SixDecimal        # the 6-decimal runs
forge test --match-path test/lean/Invariants.t.sol
forge test --match-test escrow                # the DNSSEC domain proofs and escrow (R4.14), in both decimals
forge test --match-path test/lean/DomainsInvariants.t.sol
```

| Suites | What they hold |
|---|---|
| `test/lean/Settlement.t.sol` (`LeanSettlementTest`, `LeanSettlementSixDecimalTest`) | deposits, agent keys, vouchers, claims, the three-way split, escrow and the burn batch, in 18 and 6 decimals |
| `test/lean/Claims.t.sol`, `ClaimLegs.t.sol`, `ClaimsInvariants.t.sol` | a claim's calls into the coin contracts: each leg gets its gas or the claim reverts, a failed leg is held and sent later; 6 invariants |
| `test/lean/SelfPaidUse.t.sol`, `Controllers.t.sol`, `EntryLiveness.t.sol`, `Granted.t.sol`, `SettlementAttacks.t.sol` | lines a contributor's own party paid count for nothing; who one party is; live entries; granted keys |
| `test/lean/Listings.t.sol`, `ListingsInvariants.t.sol` | listings shown at first claim, credit to the earliest root, prices, ERC-8004 signers; 2 invariants |
| `test/lean/Invariants.t.sol` (both decimals), `DomainsInvariants.t.sol` | 15 and 4 invariants: USDC equals its liabilities, Settlement holds no UNB, escrow only to a proven wallet |
| `test/lean/Pool.t.sol`, `V4UnbPool.t.sol` | the stand-in pool and the adapter over UNB's v4 pool (its fork tests run with `UNBROWSE_ARC_MAINNET_RPC` and skip without it) |
| `test/lean/DepositWithAuthorization.t.sol`, `DeployLean.t.sol` | deposits under EIP-3009; the deploy script's order and wiring |
| `test/coins/RouteCoins*.t.sol` | the coin and its curve: unit, fuzz, attack, hardening and model tests; 6 invariants |
| `test/coins/CoinStakes.t.sol`, `CoinFetch.t.sol`, `CoinBounties.t.sol` | staking lots, the fetch's pay-then-buy and held buys, bounties |
| `test/coins/Stack*.t.sol`, `RealStackInvariants.t.sol` | the coin contracts together, and with the real Settlement; 8 invariants each |
| `test/coins/QuintCoinsTraces.t.sol` | 18 traces of the Quint model replayed against the contracts, number for number |
| `test/coins/audit2/` | the second audit's proofs of concept, mutant killers and a property state machine |
| `test/regression/` | Settlement's suite on a USDC that blacklists an address, for claims and payouts |

All 540 tests forge ran passed on 2 November 2026 on branch `domain-proof`, and the 2 v4 fork tests skipped with no Arc RPC named (forge 1.8.5, 1,537 s; `--list` counts
inherited tests again, so its rows add up to more). The invariant suites are most of that: 512
runs of 256,000 calls (`[fuzz] runs = 512` in `foundry.toml`; with no `[invariant]` section, forge's depth of 500
applies), every invariant with no reverts. `forge test` needs no network: no test forks.

**The 6-decimal suites** inherit every test of the 18-decimal one and override `_usdcDecimals()` to return 6, as Arc's
USDC counts as an ERC-20.

**Domain proofs (R4.14).** `LeanSettlementTest` (and its 6-decimal twin) carries `test_escrow_*`, `test_dnssec_*` and
`test_domains_*`: a proven wallet is paid its escrow after the wait, and later shares directly; only a newer proof names
another wallet; a record proves only its own domain's `_unbrowse` name and must name exactly one wallet; a proof its
signatures don't cover is refused; a domain without DNSSEC can't be proven and its share waits in escrow
(`test_escrow_aDomainWithoutDnssecCannotBeProvenAndItsShareWaits`); a DNSSEC owner sets an execute price and hosts at
once, and a policy lists only exact lowercase hosts. `DomainsInvariants` checks that USDC is conserved with domain
proofs in play, that each domain's escrow is what accrued less what was released, and that a release pays all of it
and `Domains` itself holds no token. `ControllersTest` checks that agent keys joined both ways or in a chain have one
controller. In the node, `domains.rs` has
`an_unproven_domain_is_told_only_dnssec_proves_one` and `a_domain_has_one_canonical_form`. The site policy the node honours (R4.17) has `sitepolicy.rs`
`a_policy_refuses_entries_under_its_floor_and_every_entry_once_delisted`, `a_declared_host_counts_only_exactly_and_under_its_path`
and `a_policy_is_read_at_most_once_an_epoch`, `share.rs` `a_host_the_sites_policy_declares_may_take_the_session`, and the
ignored Anvil test `the_node_honours_a_sites_policy_from_the_chain`.

**The gas scripts** start their own Anvil, deploy the node's embedded artifacts, and print each receipt's `gasUsed`.
The contracts reference §9 says what each measures, and [MONEY.md](MONEY.md) §8 how the figures are used.

```sh
bash unbrowse-settlement/script/gas/settlement-gas.sh                  # local Anvil only, port 8599
USDC_DECIMALS=6 bash unbrowse-settlement/script/gas/settlement-gas.sh  # on a 6-decimal test USDC
bash unbrowse-settlement/script/gas/identity-gas.sh                    # forks Arc testnet, port 8598
```

Both exited 0 on 30 October 2026, in about 21 and 12 seconds.

---

## 5. The SDKs

| SDK | Command | Tests | Result |
|---|---|---|---|
| TypeScript, `unbrowse-sdk/typescript` | `npm ci && npm test` (builds, then `node --test --test-timeout=10000 test/*.test.mjs`) | `cli.test.mjs`, `client.test.mjs`, `owner.test.mjs` | 48 passed, node 22 |
| Python, `unbrowse-sdk/python` | `python -m unittest discover -s tests -v` (standard library only) | `test_cli.py`, `test_client.py` | 34 passed, Python 3.9 |

The TypeScript tests read `unbrowse-node/agent-api.json` and `skills/unbrowse` by relative path, so run them inside the
repository: copied elsewhere, three fail and one skips.

---

## 6. The window

**The native window**, `unbrowse-node/window` (Zig, on nanoui v0.6.4), needs Zig 0.17.0 (`minimum_zig_version` in
`build.zig.zon`; CI installs it with `mlugg/setup-zig@v2`).

```sh
cd unbrowse-node/window
zig build test         # src/tests.zig; with UNB_SNAP_DIR set, each test writes its frame there
zig build
```

It wasn't run for this document: the machine has no Zig. CI's `window` job runs both on macOS, and `elsewhere` builds
it on Linux and Windows.

---

## 7. The workers and the rest

**Telemetry** (`unbrowse-telemetry`): `node --test test/*.test.mjs`, 9 tests, all passed.

**The update metadata script** (`.github/scripts/updates.mjs`): `node --test .github/scripts/test/*.test.mjs`, 6 tests,
with test keys from fixed seeds. It writes the fixture the node's `the_node_reads_the_metadata_the_release_script_signs`
checks (`unbrowse-node/app/tests/fixtures/updates`); `UNBROWSE_WRITE_FIXTURES=1` writes it again. The release's dry run
on a pull request runs it.

**The landing site's worker** (the unbrowse-landing repository; its `README.md` has the detail): `npm test`, which is
`node --import ./test/workers-stub.mjs --test test/*.test.mjs`: `worker.test.mjs` checks that nothing on the worker
pays anyone (no faucet, no sponsor, spec §76) and that it takes no route on unbrowse.ai yet.

**Elsewhere in this repository:**

- `test-banks/popular-sites`: `python3 -m unittest discover -s test-banks/popular-sites -p 'test_*.py'` (16 passed)
  and `python3 test-banks/popular-sites/validate.py`. Its `probe_*.py` scripts go to real sites; they are not tests.
- Agents on the node, in CI: `qa.yml` runs nightly on staging and by hand (never on
  each push, and never on a pull request, whose code a job holding the model's credential does not run: an agent's run spends the Claude subscription's weekly allowance). Beside its checklist, which turns other web tools off,
  `.github/qa/tool_choice.py` runs tasks in fresh Claude Code sessions with `WebFetch` and `WebSearch` on hand, and reads
  from each session's record which web tool it reached for first. Run it by hand with
  `python3 .github/qa/tool_choice.py --mcp-config <file> --out <folder>`.
- Lundy's bank, nightly: `bank.yml` runs `test-banks/popular-sites/regression.json` through `run_bank.py` on a scratch node
  (`scratch-node.sh`) and holds each site to the checks it passed (`run_bank.py compare`), then Claude works through
  `.github/qa/writes.md`. It never gates a pull request: live sites change on their own, and no pull
  request runs it.
- `unbrowse-browser`: `npm run test:launcher` (4 passed). Its `evals/`, `benchmarks/` and nested `.github/workflows/`
  come from upstream; GitHub doesn't run that folder.
- `.github/qa/checklist.md`: eight checks an agent runs against a built node through its MCP tools, in `qa.yml`
  (nightly on staging, and by hand), when `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set. The report goes in
  the run's summary and its `qa-report` artifact; it posts on no pull request, and its report job holds no permission.

CI ([OPERATIONS.md](OPERATIONS.md) §6) runs none of the ignored tests, the gas scripts, the test bank, the browser's
launcher test, the landing worker or the Antithesis harness.

---

## 8. The Antithesis harness

[Antithesis](https://antithesis.com) runs a system in a deterministic simulator and injects faults (network
partitions, pauses, node kills, clock jumps) while test commands drive it, then reports which properties held. The
harness is [`antithesis/`](../antithesis): one multi-stage [`Dockerfile`](../antithesis/Dockerfile), one compose file
([`antithesis/config/docker-compose.yaml`](../antithesis/config/docker-compose.yaml)), the test commands in
[`antithesis/test/unbrowse/`](../antithesis/test/unbrowse), and the research behind it in
[`antithesis/scratchbook/`](../antithesis/scratchbook). Its guide is [`antithesis/AGENTS.md`](../antithesis/AGENTS.md).
No CI workflow runs it.

### What runs

Six containers (compose project `unbrowse-antithesis`, all `linux/amd64`). Nothing reaches a live chain or the internet
at run time.

| Container | What it is |
|---|---|
| `unbrowse-chain` | Anvil standing in for Arc testnet (chain id 5042002, 20 gwei base fee). It puts a stand-in ERC-8004 registry at Arc testnet's registry address and a 6-decimal test USDC at Arc's USDC address, deploys Settlement with the node's own `unbrowse-node chain deploy --pool 1000 1000`, and funds three owners. Every key is one of Anvil's published test keys ([`antithesis/chain/entrypoint.sh`](../antithesis/chain/entrypoint.sh)) |
| `unbrowse-site` | a fixture shop on port 8080, alias `shop.example.com` ([`antithesis/site/site.py`](../antithesis/site/site.py)): a search, a cart write, a write behind a search's name, and `/_seen`, which records who called with which cookie |
| `unbrowse-node-1` | a contributor: lists three routes, shares `all`, announces its own address |
| `unbrowse-node-2` | a caller, announces its own address |
| `unbrowse-node-3` | a caller with no announced address, so AutoNAT decides its reachability |
| `unbrowse-workload` | Python: sets up roles (pricing, listings, deposits, agent keys), waits for each caller to find the listing over the peer network, signals setup complete, then hosts the test commands |

The nodes run in live mode (`UNBROWSE_CHAIN=arc-testnet`, `UNBROWSE_RPC=http://unbrowse-chain:8545`), built with the
`antithesis-coverage` feature ([`antithesis/node/entrypoint.sh`](../antithesis/node/entrypoint.sh)).

**Assertions in the node.** [`unbrowse-node/app/src/antithesis.rs`](../unbrowse-node/app/src/antithesis.rs) (and
`crates/net/src/antithesis.rs`) defines `sut_always!`, `sut_always_or_unreachable!`, `sut_sometimes!`,
`sut_reachable!`, `sut_unreachable!` and `sut_always_less_than_or_equal_to!`. With the `antithesis` feature each is the
SDK's assertion; without it each expands to nothing, so a normal build carries no SDK and computes no assertion's
details. `main` calls `antithesis_sdk::antithesis_init()` first under the feature. The workload uses the Python SDK
(`antithesis==0.4.0`).

**Test commands** (prefixes are Antithesis's: they say when a command may run; `helper_*` files are ignored):

| Command | Does |
|---|---|
| `parallel_driver_call.py` | callers search, fetch and pay for the contributor's routes |
| `parallel_driver_owner.py` | one owner command at a time: the contributor reprices, delists, lists again and claims; callers turn holding and light mode on and off, leave and rejoin the peer network, move the per-fetch maximum, top up, withdraw, make and revoke agent keys |
| `singleton_driver_epoch.py` | jumps the chain's clock, which must move no epoch, then mines 1, 2 or 15 epochs of blocks, up to 3 times |
| `anytime_settlement_invariants.py` | Settlement's balances against its liabilities, at any time |
| `eventually_network_recovers.py` | once faults stop, the nodes find each other and converge |
| `eventually_lines_claimed.py` | once faults stop, every payable line is claimed |
| `finally_settlement_and_bounds.py` | the end state: solvency and every bound |

### The property catalog

[`antithesis/scratchbook/property-catalog.md`](../antithesis/scratchbook/property-catalog.md) lists 43 properties,
each with an evidence file in [`antithesis/scratchbook/properties/`](../antithesis/scratchbook/properties). Where each
is asserted is in the catalog's implementation table and in
[`antithesis/scratchbook/harness.md`](../antithesis/scratchbook/harness.md). In short:

| Group | Implemented (in the node or the workload) | Only catalogued, or partial |
|---|---|---|
| Settlement and money | Settlement holds no UNB; USDC equals its liabilities; the cap is checked before the site is called; a kept body was paid for; no passed line past the cap; one unpayable line never blocks the rest; each line paid at most once; passed lines claimed within their window; the receipt ledger never shrinks | a voucher releases one body; the per-fetch maximum bounds the fee's currency; a body is never released below the current fee; auto pricing moves at most once an epoch |
| Shared routes | no paid write runs for a read goal; a delisted or superseded route isn't run from cache | a state change is never labelled a read by its name; a shared body never reaches another host or a private address; the caller runs only the signed body; release needs a live entry and a full fee; the newest listing version wins; dark only when no provider served |
| Peer network | nodes booting together find each other; admission recovers after a registry stall; a too-old peer never counts (vacuous here: no minimum version is set); a stuck listings answer frees its slot; a listings answer fits 256 KiB; a node rejoins after a failed first publish | a checked lookup spans two identities; table role follows reachability; light mode answers nothing |
| Lifecycle | owner-key writes never share a nonce; one ERC-8004 identity per owner; holds on chain converge to `held.json`; the background pass completes after chain faults stop; boot failures heal without a restart; claims run with the peer network off | a kept manifest never lowers the minimum version |

Two more were found by the local run and are confirmed defects: an entry whose body is shared with another isn't
served, and a site listed by nodes that boot together isn't found until a refusal expires.
[`antithesis/scratchbook/existing-assertions.md`](../antithesis/scratchbook/existing-assertions.md) still says there
are no assertions; it was written before them and is out of date.

### Building

From the repository root, on an amd64 machine with BuildKit (the node build forces `x86_64-unknown-linux-gnu`):

```sh
docker compose -f antithesis/config/docker-compose.yaml build
podman compose -f antithesis/config/docker-compose.yaml build     # the same with podman
```

The build context is the repository root, filtered by the root `.dockerignore` to `antithesis/`, `unbrowse-node`,
`unbrowse-browser/core` and `unbrowse-sdk/python`. The node stage applies `scripts/apply-tls-patch.sh`, builds
`cargo build --release --locked -p unbrowse-node-app --bin unbrowse-node --features antithesis-coverage` with
sanitizer-coverage flags, and checks the binary carries the instrumentation's symbols. Build args all have defaults:
`RUST_IMAGE` and `PYTHON_IMAGE` pinned by digest, `FOUNDRY_VERSION=v1.8.5` and its checksum. It makes four images:
`unbrowse-antithesis-node`, `-chain`, `-site` and `-workload` (391, 523, 129 and 149 MB). A cold build took about 25
minutes on 12 cores.

### Running it locally

```sh
podman compose -f antithesis/config/docker-compose.yaml up -d
podman logs -f unbrowse-workload        # until "workload setup: setup complete", about 13 minutes
podman exec unbrowse-workload python3 /opt/antithesis/test/v1/unbrowse/parallel_driver_call.py   # each command in turn
podman compose -f antithesis/config/docker-compose.yaml down -v
```

Setup has completed when all six containers are up, the five with health checks are healthy, and the workload's log
says each caller found the listing and then "setup complete". Outside Antithesis, `setup-complete.sh` prints that
`$ANTITHESIS_OUTPUT_DIR` is unset instead of signalling. Then each of the seven commands should exit 0. On
30 October 2026 (podman 5.5.2, Linux amd64) setup completed and every command passed once, with no Always,
AlwaysOrUnreachable or Unreachable assertion violated
([`antithesis/scratchbook/local-run.md`](../antithesis/scratchbook/local-run.md)). Reading the assertions locally needs
`ANTITHESIS_SDK_LOCAL_OUTPUT`, set by a local override that isn't committed.

About ten of those 13 minutes is the workload waiting out nodes that boot together refusing each other (`REFUSAL_TTL`,
600 + 30 s, in `antithesis/workload/entrypoint.py`). The `harness-defects` fix, still being built, will retry those
peers sooner and let one body serve several entries, and then drop this wait and restore the shared-body fixture route.

### Launching with `snouty`

`snouty` is Antithesis's command-line tool: it pushes the tagged images to the tenant's registry, reads
`antithesis/config` and starts a run. `antithesis/AGENTS.md` says to launch through the `antithesis-launch` skill
rather than calling `snouty launch` by hand, and to build first. It has not been run for this repository yet: there is
no tenant. What it needs ([`antithesis/scratchbook/harness.md`](../antithesis/scratchbook/harness.md)): an Antithesis
tenant, `ANTITHESIS_REPOSITORY` set to the tenant's image registry, the container engine logged in to it, and
`snouty` 0.8.0 or later.

```sh
snouty doctor
export ANTITHESIS_REPOSITORY=<the tenant's registry>
docker compose -f antithesis/config/docker-compose.yaml build
snouty validate antithesis/config
snouty launch --json --launcher basic_test --config antithesis/config \
  --duration 30 --source unbrowse-core --test-name "unbrowse-core antithesis-harness" \
  --description "network and money paths: 3 live-mode nodes on Anvil as Arc testnet, first run"
```

On the first run, check the report says the software was instrumented, the bootstrap property ("a node's agent API
listens on its port") fired, and there were no symbolisation errors.

### What Antithesis must enable

- **Node termination** and **clock jitter** for the tenant: the harness counts on both, and termination is often off
  by default.
- Named volumes kept across a node's termination, so a killed node restarts with its data (an assumption in
  `deployment-topology.md`).
- Nothing else: the run is offline, and only the image push needs the registry.

---

## 9. Flaky tests

No test is retried in CI, and no commit names a flake. These are the ones known to fail for reasons other than a bug:

- **The browser CLI's four timed tests**: `test_failed_local_initialization_disconnects_and_reaps`,
  `test_failed_lightpanda_initialization_disconnects_before_retry`,
  `cross_origin_command_post_is_rejected_without_relaying_to_daemon` and
  `same_origin_command_post_relays_without_wildcard_cors`. They time a fake browser or daemon against tight deadlines,
  two of them through a process-wide socket directory, and a full parallel run can trip them, so CI runs them on
  their own with `--test-threads=1` (`ci.yml`, `766476d6`). From a checkout at a long path, the `stream::http` ones
  also fail with "path must be shorter than SUN_LEN": their socket goes under the checkout's `target/t/`, past macOS's
  104-byte limit (`cli/src/native/stream/http.rs`). Run them from a short path.
- **`telemetry::tests::a_dead_or_hung_worker_never_holds_a_tool_call`** (`app/src/telemetry.rs`) was flaky on the macOS
  runner, one recording taking 330 ms. It now bounds all 10,000 calls together at 5 s (`a0527a04`, `df3c75c4`, #39).
- **`a_node_finds_another_nodes_route_by_naming_its_site`** forks Arc testnet, so it needs the internet, and fails when
  run in one process with the other `peers` tests (§3). It passes alone.
- **The fixed-port ignored tests** collide with each other and with the gas scripts when run at once (§3), and
  `a_live_network_runs_on_the_contracts_its_file_records` leaves its Anvils behind when it fails.
- **`learn_shop` and `replay_shop`** fail, rather than skip, when the browser isn't built (§2).
