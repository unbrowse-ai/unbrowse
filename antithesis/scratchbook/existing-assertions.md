---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
external_references:
  - path: <checkout>/papers/protocol.md
    why: The protocol spec's numbered requirements (routes, listings, fetching, serving, seeding, NAT, admission, no bootstrap list). Leads to validate.
  - path: <checkout>/papers/economy.md
    why: The fee rail, bond, vesting and split. Leads to validate.
  - path: AGENTS.md (repo root)
    why: The network section's stated rules.
  - path: CLAUDE.md (repo root)
    why: The general-fix rule for later stages.
---

# Existing Antithesis assertions

**There are none.** The codebase has no Antithesis SDK and no Antithesis instrumentation.

How this was checked (from the repo root, excluding `.git` and `target`):

- `grep -rIil antithesis . --exclude-dir=target --exclude-dir=.git` finds nothing. The only hit overall was `.git` (the worktree's gitdir file).
- `grep -rn "assert_always\|assert_sometimes\|assert_reachable\|assert_unreachable\|antithesis_sdk"` over the source trees finds nothing.
- `grep -c antithesis unbrowse-node/Cargo.lock` = 0. No `antithesis_sdk` crate is in the node workspace. `unbrowse-sdk/typescript/package.json` and the Python SDK pull in no Antithesis package.
- There are no Dockerfiles or compose files for the node. The only container files are `unbrowse-browser/docker/{Dockerfile.build,docker-compose.yml}`, which belong to the out-of-scope browser.

Every property in later stages starts from zero instrumentation. No evidence file should assume a `Sometimes`/`Always` already exists.

## The nearest thing to a workload: existing multi-node and chain tests

None of these use the Antithesis SDK. Their `assert!`s are ordinary Rust or forge assertions, and they inject no faults.

### Node (Rust): multi-node and chain, all `#[ignore]` and never run in CI

| Test | Where | How it runs | What it exercises |
|---|---|---|---|
| `a_route_body_travels_between_nodes_and_runs_on_the_caller` | `unbrowse-node/app/src/share.rs:624-811` | `cargo test -p unbrowse-node-app share -- --ignored --nocapture`. Needs Anvil at `~/.foundry/bin/anvil` and public DNS for `localtest.me`. Sets `UNBROWSE_DEVNET_PORT=8597` and `UNBROWSE_DEVNET_FORK=none` (the chain id is 31337, so there is no ERC-8004 registry and `DevnetRegistry` reads the ad folder `UNBROWSE_NETWORK_DIR`). | Five nodes in **one process**, each `Peer` with its own runtime and home (`share.rs:443-536`). `share_devnet` copies `mark.key`, `deployment.json`, `deployer.key` and `network.json` so all five share one Anvil (`:541-547`). A loopback shop records request lines and cookies (`:551-589`). The flow: a lists, then b, c and d find the signed listing (`:691-704`). b pays, fetches, checks and runs under its own session, and a receives the owed line (`:709-735`). The cached rerun pays nothing (`:738-744`). a leaves, then d (light mode) fetches from seeder b (`:748-762`). b leaves, then e serves a tampered body: refused, set aside, a failed line, and the entry goes off the ranking (`:766-805`). Nodes listen on 127.0.0.1 (`peers.rs:336-337`). Ends by dropping nodes, not killing them mid-operation. |
| `a_node_finds_another_nodes_route_by_naming_its_site` | `unbrowse-node/app/src/peers.rs:664-774` | `cargo test -p unbrowse-node-app peers -- --ignored --nocapture`. `UNBROWSE_DEVNET_PORT=8598`. **Needs the internet**: the devnet forks Arc testnet so the ERC-8004 registry exists (`:720`). | Two nodes on one chain. Covers the ERC-8004 registration, listing found by site, `checked == false` with one identity, `listing::verify` rejecting a changed or unposted listing, `hold_tick` on and off with on-chain `holding`, and delist invalidating the listing. |
| `a_live_network_runs_on_the_contracts_its_file_records` | `unbrowse-node/app/src/chain.rs:1859-1956` | `#[ignore = "needs Anvil"]`. Spawns `anvil --chain-id 5042002 --base-fee 20000000000` on 127.0.0.1:8594 and a plain Anvil on :8595. Sets `UNBROWSE_CHAIN=arc-testnet`, `UNBROWSE_RPC=http://127.0.0.1:8594`. | **This is the template for the Antithesis chain container.** Live mode starts with no deployment, `chain deploy` writes `networks/arc-testnet.json`, a restarted node reads it, it pays its own gas, the faucet mints only for the deployer, and a wrong-chain RPC is refused. It asserts `erc8004::ensure` fails with "no ERC-8004 registry", which is why a registry stand-in is needed (see `deployment-topology.md`). |
| `pays_and_claims_on_a_local_chain` | `chain.rs:2114-` | `#[ignore]`, `UNBROWSE_DEVNET_PORT=8599`. | Single node: faucet, deposit, list, authorise, two paid lines and a failed one, claim split on chain, withdrawal across epochs (`advance_day`). |
| `a_chain_the_node_did_not_start_is_never_taken_for_its_devnet` | `chain.rs:2080-2112` | `#[ignore]`, `UNBROWSE_DEVNET_FORK=none`, port 8597. | Devnet mark check. A second `Chain` adopts the running devnet. |
| `a_node_starts_on_arc_testnet`, `a_new_devnet_forks_arc_testnet` | `chain.rs:1958-2078` | `#[ignore = "needs the network"]` | Read-only against real Arc testnet. Out of reach in Antithesis. |
| `the_table_matches_the_live_chains` | `arc.rs:93-107` | `#[ignore = "needs the network"]` | Address table against live Arc. |

### Net crate (Rust): in-process libp2p, not ignored, run by CI

CI runs these with `cargo test --workspace --locked` on macOS (`.github/workflows/ci.yml:136`). Each test starts several `Net`s in one process over loopback with an in-memory `Registry` (`tests/network.rs:23-65`, `tests/bodies.rs:26-81`).

| Test | Where | What it exercises |
|---|---|---|
| `registered_nodes_find_a_site_and_an_unlisted_node_never_counts` | `crates/net/tests/network.rs:81-127` | Five nodes, including an unregistered "mallory". Two nodes of one identity count as one source. `checked` flips once a second identity provides. Mallory never enters any table. |
| `nodes_reach_each_other_at_the_addresses_they_publish` | `crates/net/tests/network.rs:157-181` | `listen_all(0)`, AutoNAT probe of 1 s, published addresses are dialable and are what lands in tables. Skips on a loopback-only machine. |
| `a_body_is_found_by_its_content_id_and_served_to_a_caller_that_pays` | `crates/net/tests/bodies.rs:99-127` | Provider records under `/unbrowse/body/<cid>` and fetch with payment. |
| `an_unlisted_nodes_provider_record_never_counts` | `crates/net/tests/bodies.rs:129-158` | Admission filtering of body provider records. |
| `a_provider_that_sends_more_than_a_body_may_hold_is_cut_off` | `crates/net/tests/bodies.rs:183-225` | A raw libp2p provider that ignores bounds and floods. The caller reads one byte past 64 KiB and gets `TooLarge`. |

These are the closest reusable harness for a net-only Antithesis workload: one binary, N `Net`s, a fake `Registry`, with `Config.min_peer_version` and a slow or hanging `Registry` easy to inject. The registry-hang and version-gate items (sut-analysis §5.1-5.2) are reachable this way without a chain.

### Settlement (forge): unit and fuzz, run by CI (`ci.yml:228`, `forge test`)

- `unbrowse-settlement/test/lean/Settlement.t.sol`: about 70 unit tests of the lean contract. Covered: deposit and withdraw delay (`:227-297`), agent cap, expiry and revoke terms (`:299-468`), claim signature, proof, cap, cumulative and deposit checks (`:347-760`), batch all-or-nothing (`:779-847`), split and holders (`:522-635`), escrow (`:849-`), bond join, withholding and base fold (`:1053-1165`), `postRoot` (`:1166-1207`).
- `unbrowse-settlement/test/lean/Bond.t.sol`: pure fuzz over `Bond` library math (512 runs, `foundry.toml [fuzz]`): price floor and fall, join monotonicity, withhold conservation, target properties.
- `unbrowse-settlement/test/Settlement.t.sol`, `test/EpochGate.t.sol`: tests of the **legacy** `src/Settlement.sol`, which `deploy_as` doesn't deploy (it deploys `LeanSettlement`, `chain.rs:516-542`).
- **No `invariant_*` (stateful) tests exist.** No test unbonds stake that came from withholding. A scratch probe (not committed) showed the UNB solvency gap. See sut-analysis §6 D1.
- The Lean proofs the docs cite (`formal/UnbEconomy.lean`, `Unb.*`, `UnbShare.*`) are **not in this repository**.

### What none of these cover

They don't cover network partitions or asymmetric loss between nodes or between a node and the chain; a node killed between a chain write and its local file write; a registry or RPC that hangs instead of failing; simultaneous boot of every node; claim-loop interleaving with in-flight calls; clock movement on the chain; multiple OS processes (every multi-node test is one process, sharing statics such as `OWN`, `SPENT` and `SERVED`, `peers.rs:99-101`); or real container IPs (every test is on loopback).

## Assumptions

- The ignored tests were last run by hand. Nothing in CI proves they pass at this commit.

## Open questions

- Should the in-process five-node test become the seed for the Antithesis workload's scenario (same fixture site, same route JSON at `share.rs:592-603`)? It is recommended in `deployment-topology.md`. (needs human input)
