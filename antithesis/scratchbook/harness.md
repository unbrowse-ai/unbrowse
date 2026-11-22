---
sut_path: <checkout>/harness
commit: e96f00c1e97085c40dd1455335a4d75bd7fb5c09
updated: 2026-10-30
---

# The harness: what is built, where, and how to launch it

Built by the `antithesis-setup` and `antithesis-workload` skills on the research in this scratchbook, against
unbrowse-core main e96f00c1 (#68). Not launched: there is no Antithesis account or `snouty` here.

## Layout

| Path | What |
|---|---|
| `antithesis/config/docker-compose.yaml` | Six services: `unbrowse-chain`, `unbrowse-site`, `unbrowse-node-{1,2,3}`, `unbrowse-workload`. |
| `antithesis/Dockerfile` | Stages `node-build` (instrumented release build), `harness-certs` (a test CA and a `shop.example.com` certificate), `node` (trusts the CA: OS store and `UNBROWSE_TEST_EXTRA_ROOTS`), `chain`, `site`, `workload`, from the repo root. |
| `.dockerignore` (repo root) | The build context: `antithesis/`, `unbrowse-node` (no target, vendor, UI), `unbrowse-node/crates/browser`, `unbrowse-sdk/python`. |
| `antithesis/chain/entrypoint.sh` | Anvil as Arc testnet (chain id 5042002); the stand-in ERC-8004 registry; a 6-decimal USDC at `0x3600…`; Settlement, UNB and the pool deployed by `unbrowse-node chain deploy --pool 1000 1000`; owners get gas and test USDC, and no UNB (no faucet, spec §76). |
| `antithesis/node/entrypoint.sh` | Seeds `/data` on first boot (root key, settings, network file, routes or jar), a TCP relay `:7700 → 127.0.0.1:7788`, then `unbrowse-node`. |
| `antithesis/node/route-{items,cart,lookup}.json` | The shop's routes node-1 lists: a search; a POST that writes ("Add an item to the cart"); and the same POST listed in read words ("Look up items"), which a read goal must be refused (the #25 case). |
| `antithesis/site/site.py` | The fixture shop at the alias `shop.example.com`: its API over HTTPS on :443 under the harness CA; plain HTTP on :8080 only for `/_seen` (who called, with which cookie) and the healthcheck. |
| `antithesis/workload/entrypoint.py` | Roles (node-1 prices and lists, with no opening bond: spec §85; callers deposit and make agent keys), then `setup-complete.sh`, then idles. |
| `antithesis/test/unbrowse/` | The test template (below). |
| `antithesis/local/` | Local runs with no tenant: `soak.sh` (one seeded run, replayable from its seed), `explore.sh` (coverage-guided search over fault profiles), `nemesis.sh` (faults: partition, split, slow, lossy, pause, stall, crash, chain), `known-violations.txt`, `override.yaml` (SDK output to files), `summarise.py`. Never read by snouty. |
| `antithesis/setup-complete.sh` | From the skill: writes `setup_complete` to `$ANTITHESIS_OUTPUT_DIR/sdk.jsonl`. |

node-1 and node-2 name their own container address (`NODE_ANNOUNCE=self` → `UNBROWSE_ANNOUNCE`); node-3 is left
to AutoNAT, so both ways a node becomes reachable run. Setup lists node-1's routes only once every node has published
its ERC-8004 metadata and ten minutes have passed (finding 1 in `local-run.md`).

Keys are Anvil's published test accounts: 0 is the platform (deployer, faucets), 1-3 own node-1..3. Nothing touches a
live chain or the internet at run time.

### Instrumentation

- **Node (Rust):** `antithesis_sdk` 0.3.0 and `antithesis-instrumentation` 0.1.1, optional, behind the features
  `antithesis` (assertions) and `antithesis-coverage` (plus the runtime; only with the sanitizer-coverage rustflags the
  Dockerfile passes). Default builds and `cargo test --workspace --locked` are unchanged; `Cargo.lock` gained the two
  crates and their dependencies (linkme, linkme-impl, rustc_version_runtime). `antithesis_init()` runs first in `main`.
  The build checks `nm … antithesis_load_libvoidstar` and the `__sancov_guards` section; the binary is unstripped with
  line tables and linked at `/symbols/unbrowse-node`.
- **Bootstrap property:** `Reachable("a node's agent API listens on its port")` in `api::serve`.
- **Workload (Python):** `antithesis` 0.4.0; `/opt/antithesis/catalog/unbrowse` → the test template for cataloging.
- **Chain, site:** uninstrumented (Anvil and a stub; the chain container runs the node binary once, to deploy).

## Test template `unbrowse`

| Command | Does | Checks |
|---|---|---|
| `parallel_driver_call.py` | A burst (1, 2, 9, 10 or 11 calls: the cap's room is 10) of read goals ("search items", "look up items"), write goals, entry calls and searches from one caller's agent. Weights drawn per timeline; query values from a menu (empty, one letter, unicode, URL metacharacters, 2 KiB). | a named server is another node; pays no more than the highest fee the contributor sets; a kept body reruns free; the shop hears only the callers' own sessions; reach claims for a paid fetch, an unnamed server, seeder serving, a write run. A read goal refused a write route is seen node side only (the 409 is folded into the goal's fall-through to the browser). |
| `parallel_driver_owner.py` | One owner command: node-1 reprices, delists, relists, claims; callers toggle holding, light, peer network, move `max_fetch_usdc` around the fee, deposit, ask to withdraw, withdraw vested, make and revoke agent keys, claim now. | reach claim for a delist. |
| `singleton_driver_epoch.py` | Jumps the chain clock, then mines 1, 2 or 15 epochs of blocks, up to 3 times, at most 60 days. | reach claim. |
| `anytime_settlement_invariants.py` | `helper_invariants.check`, `identities`, `ledgers`. | below |
| `eventually_network_recovers.py` | After faults: callers back on the network find the listing through the peer network again; an entry still delisted runs from no kept copy once `LIVE_FOR` has passed; `held.json` equals the chain's holds. | Always, with deadlines |
| `eventually_lines_claimed.py` | After faults: claimed ≥ signed for every key and claimable epoch, within six passes. | Always |
| `finally_settlement_and_bounds.py` | The invariants on the final state; acknowledged ≤ passed lines ≤ tried calls. | Always |

Settlement invariants (`helper_invariants.check`), all read at one pinned block: UNB held ≥ Σ (filled + unbonding);
USDC held == Σ deposits + Σ escrow + Σ (vesting + vested); no line claimed more often than signed; a key never paid
past what its node signed; `claimedOf ≤ termsFor` cap per epoch; every server a claimed line names (not the payer or
its keys) is in that claim's `Vesting`/`BondWithheld`, and nobody else earns; `withdrawVested` estimates under the
block gas limit for every earner with vested earnings. Wallets are gathered from Settlement's own events.

## SUT assertions (message = stable property name)

| File | Assertion | Property |
|---|---|---|
| `app/src/api.rs` `serve` | Reachable "a node's agent API listens on its port" | bootstrap |
| `app/src/chain.rs` `reserve` | Reachable "a paid call was refused for the cap before it fetched a body or reached the site"; Sometimes "a paid call took its place under the cap while another call held one" | cap-is-checked-before-the-site-is-called |
| `app/src/chain.rs` `Reserved::line` | Unreachable "a reserved call's passed line was refused for the cap or the deposit after it ran" | cap / no-passed-line-past-the-cap |
| `app/src/chain.rs` `write_line` | AlwaysLessThanOrEqualTo "a passed line never takes the epoch's signed total past the key's cap" | no-passed-line-past-the-cap |
| `app/src/api.rs` `call_entry` | Reachable "a fetched route that writes was refused for a read goal, billed and kept unrun"; Always "a fetched route that writes is kept for a read goal only with a passed line for its fetch" | a-kept-body-was-paid-for, write gate |
| `app/src/api.rs` `call_entry` | AlwaysOrUnreachable "a network route that writes never runs for a goal that only reads"; Sometimes "a network route that writes was fetched and run for a goal that asks for a change" | network-write-never-auto-run-for-a-read-intent |
| `app/src/api.rs` `run_route` | Always "a fetched body is kept only with a passed line written for its use" | a-kept-body-was-paid-for |
| `app/src/api.rs` `run_route` | AlwaysOrUnreachable "a kept route that writes runs only on a fresh answer that its entry is live" | delist reaches kept copies |
| `app/src/share.rs` `still_listed` | Reachable "a kept copy of a delisted route was dropped instead of run"; Reachable "a kept route that writes didn't run while the chain couldn't say it is listed" | delist reaches kept copies |
| `app/src/rpc.rs` `write_turn`, `not_sent` (via `mined!`) | Reachable "an owner-key write waited for another to be mined"; Unreachable "an owner-key write was refused for its nonce" | owner-key-writes-never-share-a-nonce |
| `app/src/chain.rs` `deposit` | Reachable "a deposit was refused to keep the gas a full claim batch needs" | #68 `claim_reserve` |
| `app/src/chain.rs` `claim` | Always "a stream whose epoch has closed is never held back for its gas"; Reachable "a claim waited until its lines were worth their gas" | passed-lines-are-claimed-within-their-window, #68 `claim_due` |
| `app/src/main.rs` `claim_loop` | Sometimes "a claim pass completed after the one before it failed"; Reachable "a node's background pass of claims, pricing and holding completed"; Sometimes "a background pass completed after the chain held it up for over two minutes" | background-pass-completes-after-chain-faults-stop |
| `app/src/peers.rs` `hold_tick`, `release_all` | Reachable "a node's held routes were reconciled with the holds the chain shows"; "a hold the chain already had was recorded instead of sent again"; "a hold whose release failed stayed on record to be released again" | holding-on-chain-converges-to-held-json |
| `crates/net/src/node.rs` `standing`, `judged` | AlwaysOrUnreachable "a peer Identify found too old never counts"; Always "an admission never lands for a peer already seen too old" | too-old-peer-never-counts |
| `crates/net/src/node.rs` hello response, `AskAgain`, `judged` | Reachable "a peer was left unjudged because its registry read failed or timed out"; Reachable "a peer the registry couldn't be read for was asked again"; Sometimes "a peer was admitted after a registry read for it had failed" | admission-recovers-after-registry-stall |
| `crates/net/src/node.rs` listings | Always "a listings answer a node sends fits the bound its asker reads"; Reachable "a listings answer that took too long was given up and its slot given back"; AlwaysLessThanOrEqualTo "listings answers in flight never exceed their slots" | listings-answer-fits-its-bound, listings-answering-survives-a-stuck-answer |

The version-gate assertions are AlwaysOrUnreachable/Always on paths this topology reaches only with a peer below
`min_peer_version`, which non-release builds never set: they hold vacuously here. Two reach claims were left out
because this topology can't fire them and an unfired reach claim reads as a failing property: a write refused for
gas at `chain::can_pay` (every owner has 1,000 ETH of gas) and a listings request dropped with all 16 slots taken
(three nodes). Both belong to a gas-starved node or the net-only harness.

Several SUT assertions restate a check made just before them (`write_line`'s cap, `judged`'s too-old verdict,
`call_entry`'s write gate, `claim`'s closed epoch, the slot bound). They are regression guards: they fail if the
check is removed or reordered, and say nothing about search coverage.

## Deferred, and why

- `body-voucher-releases-one-body`, `caller-runs-only-the-signed-body` (tampered provider),
  `a-shared-body-never-reaches-a-host-off-its-site-nor-a-private-address` (hostile body), `too-old-peer-never-counts`
  (reaching it): need an adversarial or raw libp2p peer. The net-only harness of `deployment-topology.md` is the place.
- `lookup-keeps-newest-listing-version`, `two-distinct-identities-is-only-as-strong-as-registration-is-costly`:
  open questions for a human (catalog Q7, Q8).
- `a-state-change-is-never-classified-a-read-by-its-endpoint-name`: a learner classification, cheaper as a unit test.
- `auto-pricing-moves-the-fee-once-per-epoch`: manual and automatic fee writes emit the same `FeeSet`.
- `entry-dark-only-when-providers-served-nothing`, `checked-lookup-spans-two-identities`, `table-role-follows-reachability`,
  `light-mode-answers-no-queries-on-any-protocol`: need peer-internal state the workload can't see; the drivers already
  exercise them (light toggles, seeding).
- `kept-manifest-pair-never-lowers-min-version`: the update path isn't in this topology.
- `delisted-or-underpaid-body-never-released`: the assertion would restate the check in `share::release`.

## Launch (antithesis-launch, not run)

Needs: an Antithesis tenant and its registry (`ANTITHESIS_REPOSITORY`, e.g.
`us-central1-docker.pkg.dev/molten-verve-216720/<tenant>-repository`), the engine logged in to it, and `snouty` ≥ 0.8.0.

```sh
snouty doctor                       # names the engine and compose CLI to build with
export ANTITHESIS_REPOSITORY=<registry from the tenant>
docker compose -f antithesis/config/docker-compose.yaml build      # or: podman compose …
snouty validate antithesis/config
snouty launch --json --launcher basic_test --config antithesis/config \
  --duration 30 --source unbrowse-core --test-name "unbrowse-core antithesis-harness" \
  --description "network and money paths: 3 live-mode nodes on Anvil as Arc testnet, first run"
```

Images snouty pushes: `unbrowse-antithesis-node:latest`, `unbrowse-antithesis-chain:latest`,
`unbrowse-antithesis-site:latest`, `unbrowse-antithesis-workload:latest`. First-run checks: "Software was
instrumented", the bootstrap property, no symbolization errors. Ask for node termination and clock jitter on the
tenant (`deployment-topology.md` open questions).

## Local run on the deck

See `local-run.md`.
