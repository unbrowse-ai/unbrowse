---
sut_path: <checkout>/harness
commit: e96f00c1e97085c40dd1455335a4d75bd7fb5c09
updated: 2026-10-30
---

# Local run on the deck (2026-10-30)

No Antithesis account or `snouty`, so `snouty validate` was not run. In its place: the whole topology brought up
with `podman compose` (Docker Compose v2.39.1 through podman 5.5.2's socket) on the deck (Linux amd64), each test
command run once with `podman exec`, no faults, and every assertion the SDKs recorded read back from their local
output (`ANTITHESIS_SDK_LOCAL_OUTPUT`, set by a local-only override, not by `antithesis/config`).

## Build

- `podman compose -f antithesis/config/docker-compose.yaml build`: all four images built, each `amd64`
  (`podman image inspect … --format {{.Architecture}}`). Sizes: node 391 MB, chain 523 MB, site 129 MB,
  workload 149 MB.
- The instrumented release build of `unbrowse-node` (`--features antithesis-coverage`, the sanitizer-coverage
  rustflags, `codegen-units=1`) took about 25 minutes from cold on the deck's 12 cores. The Dockerfile's own checks
  passed: `nm` finds `T antithesis_load_libvoidstar`, `readelf -S` finds `__sancov_guards`. `/symbols/unbrowse-node`
  links the unstripped binary.
- On the Mac: `cargo test --workspace --locked` (default features) 464 passed, 0 failed, 30 ignored;
  `cargo check -p unbrowse-node-app --bin unbrowse-node` with and without `--features antithesis`, no new warnings.

## The final run (output as recorded)

```
== up 2026-10-30T13:40:45Z
== after 775s:
unbrowse-site Up 13 minutes (healthy)
unbrowse-chain Up 13 minutes (healthy)
unbrowse-node-1 Up 13 minutes (healthy)
unbrowse-node-3 Up 13 minutes (healthy)
unbrowse-node-2 Up 13 minutes (healthy)
unbrowse-workload Up 12 minutes
== chain log
  "existing": {
    "usdc": "0x3600000000000000000000000000000000000000",
    "unb": null,
    "pool": null
  }
}
chain: set up; Settlement 0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6
chain: ready on :8545
== workload log
workload setup: every node has published; waiting out refusals made before that
workload setup: node-1 listed {'route-items': '0x36b7a4ea055e199139372bddbbdc86764055af5c4715dfb29cfb115387ef16cc', 'route-cart': '0x2208eaa909f1a90cf5f59d787ec93facf629935d8b7d421fb175b37fae18413c', 
workload setup: node-2 agent 0 0x71F217e6501d19FfB83F87435Db4565D773735f6
workload setup: node-3 agent 0 0xA9ea03025305e09305b78574280A1Af7e83985f4
workload setup: node-2 finds the listing
workload setup: node-3 finds the listing
$ANTITHESIS_OUTPUT_DIR is unset, not emitting setup-complete
workload setup: setup complete
== parallel_driver_call.py exit 0 in 3s
Assertion output will be sent to: "/state/sdk-parallel_driver_call.py.jsonl"
== parallel_driver_call.py exit 0 in 1s
Assertion output will be sent to: "/state/sdk-parallel_driver_call.py.jsonl"
== parallel_driver_call.py exit 0 in 0s
Assertion output will be sent to: "/state/sdk-parallel_driver_call.py.jsonl"
== parallel_driver_owner.py exit 0 in 1s
Assertion output will be sent to: "/state/sdk-parallel_driver_owner.py.jsonl"
== parallel_driver_owner.py exit 0 in 7s
Assertion output will be sent to: "/state/sdk-parallel_driver_owner.py.jsonl"
== anytime_settlement_invariants.py exit 0 in 1s
Assertion output will be sent to: "/state/sdk-anytime_settlement_invariants.py.jsonl"
== singleton_driver_epoch.py exit 0 in 1s
Assertion output will be sent to: "/state/sdk-singleton_driver_epoch.py.jsonl"
== parallel_driver_call.py exit 0 in 1s
Assertion output will be sent to: "/state/sdk-parallel_driver_call.py.jsonl"
== anytime_settlement_invariants.py exit 0 in 0s
Assertion output will be sent to: "/state/sdk-anytime_settlement_invariants.py.jsonl"
== eventually_network_recovers.py exit 0 in 687s
Assertion output will be sent to: "/state/sdk-eventually_network_recovers.py.jsonl"
== eventually_lines_claimed.py exit 0 in 1s
Assertion output will be sent to: "/state/sdk-eventually_lines_claimed.py.jsonl"
== finally_settlement_and_bounds.py exit 0 in 0s
Assertion output will be sent to: "/state/sdk-finally_settlement_and_bounds.py.jsonl"
```

Every test command exited 0. `setup-complete.sh` ran from the workload's entrypoint and, outside Antithesis, said it
had nowhere to write.

What the drivers did in this run: 16 calls (10 write goals, 4 read goals, 2 searches), two paid fetches served by
node-1 and reruns from the kept copies at no charge, a write route fetched and run for a write goal, a read goal
refused the read-worded write route (node side), lines claimed on chain with a named server, a delist reaching a
kept copy, and the chain clock moved one epoch.

## Every assertion the SDKs recorded

`held` means the condition was true every time it was evaluated; `unfired` means a reach claim this short, fault-free
run didn't reach (most need faults: registry stalls, chain partitions, restarts).

```
== node side (all three nodes)
Sometimes                    hit, never true      hits=3    a claim pass completed after the one before it failed
Sometimes                    hit, never true      hits=3    a background pass completed after the chain held it up for over two minutes
Reachable                    fired                hits=3    a node's background pass of claims, pricing and holding completed
Reachable                    fired                hits=1    a fetched route that writes was refused for a read goal, billed and kept unrun
AlwaysOrUnreachable          held                 hits=2    a network route that writes never runs for a goal that only reads
Sometimes                    fired                hits=3    a network route that writes was fetched and run for a goal that asks for a change
Always                       held                 hits=1    a fetched route that writes is kept for a read goal only with a passed line for its fetch
Reachable                    fired                hits=3    a node's agent API listens on its port
AlwaysOrUnreachable          held                 hits=1    a kept route that writes runs only on a fresh answer that its entry is live
Always                       held                 hits=2    a fetched body is kept only with a passed line written for its use
Reachable                    fired                hits=3    an owner-key write waited for another to be mined
Always                       held                 hits=2    a stream whose epoch has closed is never held back for its gas
Reachable                    unfired              hits=0    a claim waited until its lines were worth their gas
Reachable                    unfired              hits=0    a deposit was refused to keep the gas a full claim batch needs
Reachable                    unfired              hits=0    a hold whose release failed stayed on record to be released again
Reachable                    unfired              hits=0    a node's held routes were reconciled with the holds the chain shows
Reachable                    unfired              hits=0    a hold the chain already had was recorded instead of sent again
Reachable                    fired                hits=1    a kept copy of a delisted route was dropped instead of run
Reachable                    unfired              hits=0    a kept route that writes didn't run while the chain couldn't say it is listed
Unreachable                  held (not reached)   hits=0    a reserved call's passed line was refused for the cap or the deposit after it ran
Unreachable                  held (not reached)   hits=0    an owner-key write was refused for its nonce
Always                       held                 hits=2    a passed line never takes the epoch's signed total past the key's cap
Reachable                    unfired              hits=0    a paid call was refused for the cap before it fetched a body or reached the site
Sometimes                    fired                hits=4    a paid call took its place under the cap while another call held one
Reachable                    unfired              hits=0    a peer the registry couldn't be read for was asked again
Reachable                    unfired              hits=0    a listings answer that took too long was given up and its slot given back
Always                       held                 hits=1    a listings answer a node sends fits the bound its asker reads
Reachable                    unfired              hits=0    a peer was left unjudged because its registry read failed or timed out
AlwaysOrUnreachable          held                 hits=3    a peer Identify found too old never counts
Always                       held                 hits=3    an admission never lands for a peer already seen too old
Sometimes                    hit, never true      hits=3    a peer was admitted after a registry read for it had failed
Always                       held                 hits=1    listings answers in flight never exceed their slots
== workload side
Always                       held                 hits=3    Settlement's UNB covers every bond and everything unbonding
Always                       held                 hits=3    Settlement's USDC equals its deposits, escrow and vesting
Sometimes                    hit, never true      hits=3    a server's or contributor's earnings were withheld into its bond through the pool
Sometimes                    fired                hits=3    a passed line was claimed on chain
Always                       held                 hits=3    an agent key is never paid out more than its node signed for
Always                       held                 hits=3    the claims of an epoch never pass its agent key's cap
Always                       held                 hits=3    an owner registers at most one ERC-8004 identity
Always                       held                 hits=3    a receipt file never holds fewer lines than it once did
Always                       held                 hits=1    every passed line in its claim window is claimed once faults stop
Always                       held                 hits=1    after faults stop every caller finds the contributor's listing through the peer network
AlwaysOrUnreachable          held                 hits=1    a delisted route stops running from kept copies once faults stop
Always                       held                 hits=1    a node's held routes match the holds the chain shows once faults stop
Always                       held                 hits=1    no receipt line is claimed more often than it was signed
AlwaysOrUnreachable          held                 hits=1    the serving share of a claimed line reaches the server it names
Sometimes                    fired                hits=1    a claimed line named a server other than its payer
AlwaysOrUnreachable          held                 hits=1    nobody earns from a claim but its contributors and the servers its lines name
Always                       held                 hits=1    every call acknowledged as paid left a passed line
Always                       held                 hits=1    no more passed lines exist than calls were tried
Sometimes                    fired                hits=2    a caller's search finds the contributor's listing
Sometimes                    hit, never true      hits=2    a paid fetch's server couldn't be named
AlwaysOrUnreachable          held                 hits=2    a paid fetch names another node that holds the body as its server
Sometimes                    hit, never true      hits=2    a body was served by a seeder rather than its contributor
AlwaysOrUnreachable          held                 hits=2    a call pays no more than the highest fee the contributor sets
Reachable                    fired                hits=2    a caller paid for a body, fetched it and ran it itself
Reachable                    fired                hits=3    a route that writes ran for a call that asks for a change
AlwaysOrUnreachable          held                 hits=2    a caller runs a kept body again without paying
AlwaysOrUnreachable          held                 hits=3    the shop hears a caller only under that caller's own session
Reachable                    fired                hits=1    the contributor delisted a route other nodes may keep
Reachable                    fired                hits=1    the chain's clock moved epochs on while the nodes worked
```

No Always, AlwaysOrUnreachable or Unreachable was violated.

## Findings

1. **A site listed by nodes booting together isn't found for at least ten minutes, and the contributor's restart
   doesn't help** (`properties/a-site-listed-by-nodes-booting-together-is-found.md`, status C). In the first runs the
   workload listed node-1's routes about a minute after the nodes answered. Neither caller's search was answered by
   the peer network for 10+ minutes, and every paid call failed `502 "no node answered with the entry's signed
   listing"`. Restarting node-1 didn't help; restarting the callers did, within a minute. Suspected: peers judged
   before their ERC-8004 metadata was published are refused for `refusal_ttl`, and the provider records they send
   meanwhile are dropped and not resent for a day. The harness's setup now waits for every node's
   `peer-published.json` and then 630 s before listing, so the drivers start from a formed network.
2. **Of two listed entries with byte-identical bodies, the second is never served**
   (`properties/every-listed-entry-is-served-even-when-its-body-is-shared.md`, status C). `share::held` serves a body
   under the first entry whose content id matches, and `release` refuses the other entry's voucher ("the voucher
   pays for another entry"). The fixture's read-worded write route now has its own call.
3. **Two harness problems fixed on the way:** podman's handling of an exec-form healthcheck split the Python `-c`
   string (now `CMD-SHELL`), and the entrypoints weren't executable.

An earlier guess, that AutoNAT alone never made a node a table server here, was wrong: it was finding 1. In the
final run node-3, left to AutoNAT, found the listing through the peer network like node-2.

## Reproducing it

On a Linux amd64 machine with podman and Docker Compose v2 (or Docker), from the repo root:

```sh
podman compose -f antithesis/config/docker-compose.yaml build
podman compose -f antithesis/config/docker-compose.yaml up -d
podman logs -f unbrowse-workload            # until "workload setup: setup complete" (about 13 minutes)
podman exec unbrowse-workload python3 /opt/antithesis/test/v1/unbrowse/parallel_driver_call.py   # and so on
podman compose -f antithesis/config/docker-compose.yaml down -v
```

## After the fixes (branch `harness-defects`, 2026-10-30)

Both findings are fixed in the node; see each property file's "fixed" section. In the harness:

- `workload/entrypoint.py` no longer waits for every `peer-published.json` and then `REFUSAL_TTL` (630 s) before
  listing: the routes are listed as soon as the nodes answer, and the callers finding the listing is the check.
- `node/route-lookup.json` is again the duplicate body: the same `POST /api/cart` call as `route-cart`, listed as
  "Look up items", so two entries share one content id. `site/site.py` is back to the shop without `/api/lookup`.
  `parallel_driver_call.py` gains `call_lookup`, a paid call of that entry.

Not re-run on the deck yet.

## Rebased on the papers spec (2026-11-03)

Run against core `origin/main` d35db2f with the design spec at unbrowse-papers `staging` 96562f9 (§76 to §86). As it
stood, the harness reached no paid path on main:

1. Setup stopped at the first listing: `400 "this route was learned while the node was off the network"`. Since §86 a
   route learned before the node joined stays on it (R2.8); the fixtures carry `learned_at: 1`. They now say
   `"local": false` (learned on the network).
2. Every call was refused. A route fetched from another node goes only over HTTPS to a public internet address
   (`egress.rs` `Egress::Foreign`, commit 083a240), and the shop was plain HTTP on a private address. The shop now
   serves HTTPS under a test CA made at build (`harness-certs`), the compose network is the public-range subnet
   `11.77.0.0/24`, and the nodes trust the CA: in the OS store for the OS-verified clients, and through
   `UNBROWSE_TEST_EXTRA_ROOTS` for the Chrome-shaped transport, which keeps its own bundled roots. The latter is read
   only by a build with the `antithesis` feature (learn feature `test-roots`, `http.rs` `test_roots`); the HTTPS and
   public-address rule itself is unchanged, so the harness tests the production rule.
3. The chain reads named an `EntryListed` event no ABI has (listings travel signed on the peer network; Settlement
   holds only their roots) and called `holding` on Settlement, which lives in `RouteStakes`.
   `anytime_settlement_invariants` died with `KeyError`, and "held routes match the holds the chain shows" reported a
   false violation. Entries are now read back with `entry(id)` (contributor, domain hash, live), holds from
   `RouteStakes`, and a claim's epoch from the contract's own `epoch()`.
4. The setup modelled the retired priced bond: a 250,000 UNB opening bond and a 300,000 UNB faucet per owner. Both are
   gone (§85 R6.4, R6.8; §76 R9.17).

New checks taken from the spec:

- `a wallet that never listed has none of its earnings withheld (R6.8)` and `a listing wallet's claim has exactly half
  withheld and the rest paid (R6.9)`, per claim transaction from `Vesting` and `BondWithheld`.
- `a clock jump with a single block never moves the epoch: epochs are counted in blocks (R1.28)`, in the epoch driver.
  Main counts epochs from the timestamp (`LeanSettlement.sol` `epoch()`), so this fires there: a spec deviation, not a
  harness defect.

With these, `snouty validate antithesis/config` passes (setup-complete seen; 3 driver, 1 anytime, 2 eventually, 1
finally commands), and a short local run reaches paid fetches, a write route run for a write goal, a read goal refused
the write route, and 58 assertions with one violation, R1.28 above.

A 12-minute local soak afterwards (60 rounds of two call drivers and the owner driver, the epoch driver every sixth
round, the settlement invariants every third, then the eventually and finally commands): 21 lines claimed on chain,
R6.9 held on all 20 claims of the listing wallet, and two violations. R1.28, as above, and "after faults stop every
caller finds the contributor's listing" for node-2. That second one was the harness: the owner driver had delisted all
of node-1's routes and nothing listed them again, so there was nothing to find. `eventually_network_recovers` now lists
the contributor's routes again before it judges (all three relists answered 200, so all three had been delisted).
A second soak (50 rounds): 17 claims, R6.9 held on 16, and R1.28 the only violation.

Write goals falling back to a browser walk (`422 "no Chromium browser"`) turned out to be a node defect against the
spec, not the harness: `Share::saw` keeps one listing per entry, so of route-cart and route-lookup (one body, so one
entry, R2.4) a client knows only the listing it saw last, "Look up items". "add an item to the cart" then matches no
listing. With no owner driver running: 0 of 6 write goals served, 6 of 6 searches served. See
`properties/listings-of-one-body-all-count.md`; the new Sometimes for it was hit 11 times and never true.

Still open: an Antithesis tenant and API key are needed for `snouty launch`.

## Running it locally, with faults (`antithesis/local/`)

With no tenant, `antithesis/local/soak.sh` (from the repo root) is the run: it builds the images, brings the topology
up with `local/override.yaml` (SDK assertions to files), waits for setup, runs the drivers for `SOAK_MINUTES` while
`local/nemesis.sh` injects faults, stops the faults, waits a minute, runs the `eventually_` and `finally_` commands,
and reads every assertion back (`local/summarise.py`). It prints `ANTITHESIS_LOCAL_SOAK_PASSED` only when no Always,
AlwaysOrUnreachable or Unreachable was violated.

The nemesis partitions a node, the chain or the shop (netem loss 100%), slows one (netem delay), pauses one (SIGSTOP),
crashes a node (SIGKILL, then start) or crashes Anvil, one fault at a time, every `NEMESIS_GAP` seconds or so. It
enters a container's network namespace with `podman unshare nsenter` and the host's `tc`, so it works rootless. It is
a stand-in: seeded (`NEMESIS_SEED`) but not deterministic, with no exploration and no replay. What Antithesis adds
over it is exactly those.

### First fault soak (2026-11-03, `NEMESIS_SEED=1103`, 20 min)

`ANTITHESIS_LOCAL_SOAK_FAILED violations=1`: 72 driver rounds, 29 faults (18 crashes: Anvil 5, node-1 6, node-2 4,
node-3 3; 5 partitions; 3 pauses; 3 slowdowns), 68 assertions.

- The one violation is the known R1.28 deviation (11/11): `epoch()` reads `block.timestamp`, so a clock jump in one
  block moves the epoch. Not caused by faults.
- Every recovery check held once faults stopped: every passed line claimed once, every caller finds the contributor's
  listing, the holds match the chain, every acknowledged paid call left a line, and no more lines than calls.
- Under faults the money checks held 24/24 (USDC and UNB conservation, no line claimed twice, key caps), and R6.9 held
  6/6.
- Not reached (Sometimes, never true): a body served by a seeder rather than its contributor (4); a background pass
  outliving a chain stall of over two minutes (pauses here last at most 60 s); a peer admitted after its registry read
  failed (16); and the write goal (62, the `Share::saw` defect in `properties/listings-of-one-body-all-count.md`).
- The driver loop must wait on the drivers' own pids: a bare `wait` also waits on the nemesis, so the first attempt ran
  one round in 2 h.

## Without Antithesis at all: replay and exploration locally

What a tenant adds over the soak is a replayable run and a search for rare states. `antithesis/local/` now does a
version of both on one machine.

- **Replay from one seed.** `SOAK_SEED` seeds the nemesis (bash `RANDOM`) and every test command. Each command runs
  under `random.seed(SEED * 1000003 + its place in the run)`, and outside Antithesis the SDK's `antithesis.random` falls
  back on Python's `random`. So one seed and one profile (`NEMESIS_GAP`, `NEMESIS_KINDS`) give the same faults, in the
  same order and of the same lengths, and the same driver decisions. A failed run prints its `replay:` command;
  `OUT/run.env` and `OUT/schedule.tsv` record it. What a seed does not fix is the interleaving: thread and network
  timing are the machine's. A replay is close, and a timing-only bug may need several. Antithesis's hypervisor makes
  that exact; nothing here does.
- **Exploration.** `explore.sh` makes many short seeded runs.
  - Half take a fresh profile: each fault kind is in with even odds (swarm testing).
  - Half mutate a profile that once made a new Sometimes or Reachable come true: a new seed, the gap moved, one kind
    added or dropped.
  - `explore/seen.txt` collects everything that has come true; `explore/frontier.txt` lists what never has, which is
    where the search is still blind. Violations go to `explore/failures.tsv` with the replay command.
  - Antithesis branches from the middle of a run; this restarts from setup each time. It is coarser and slower, and
    it is the same idea.
- **Faults added for the frontier.**
  - `split`: two nodes stop reaching each other while both still reach the chain and the shop (prio + u32 + netem in
    each node's namespace).
  - `stall`: the chain is frozen for 120–200 s, past the two-minute wait a node's background pass has.
  - `lossy`: some loss, duplication and reordering.
- **Known violations** (`known-violations.txt`) print as KNOWN and do not fail a run, so a search does not stop on
  R1.28. Remove a line once its fix lands.
- The nemesis runs under docker too (nsenter under sudo), so the same scripts can run on a Linux CI runner. That is not
  wired into CI yet.

### First explore (2026-11-04, `EXPLORE_SEED=1104`, 8 runs × 6 min)

`ANTITHESIS_LOCAL_EXPLORE_DONE runs=8 failures=0 seen=27 frontier=9`. No violations beyond R1.28. 27 assertions came
true across the runs. The 20-minute all-faults soak reached 20, and 7 states were reached only here:

- a background pass outlived a chain stall of over two minutes (`stall`)
- a body was served by a seeder rather than its contributor
- an entry whose body another entry also lists was paid for and fetched
- a network route that writes was fetched and run for a change goal
- a kept route that writes did not run while the chain could not say it is listed
- a deposit was refused to keep the gas a full claim batch needs
- a peer that counts and was missing from the table was put back

Five profiles found something new; the corpus is in `explore/corpus.tsv`. The frontier, which no run has reached:

- Registry reads failing for a peer (asked again, admitted after, left unjudged). A node partition drops everything,
  so no new peer connects while a registry read fails. This needs a fault that cuts a node from the chain only, the
  way `split` cuts two nodes.
- Hold bookkeeping (a hold already on chain recorded, a failed release kept, holds reconciled). This needs owner hold
  toggles to land while the chain is down.
- The body store's LRU: `storage_gb` is 1.0 in `node/entrypoint.sh` and the fixture bodies are bytes. A harness gap;
  a tiny limit on one node would reach it.
- A paid fetch whose server could not be named.
- The write goal: the `Share::saw` defect, not a harness gap.

### Frontier follow-up (2026-11-04)

- **Write goal:** fixed in the node (`properties/listings-of-one-body-all-count.md`), and reached: 45 of 45 true.
- **`cut` fault** (nemesis): a node loses the chain while it still reaches its peers and the shop. It is for the
  registry-read and hold-bookkeeping assertions, which need a chain failure under live peer traffic. It fired once in
  the 12-minute soak; the explore below measures it.
- **Body-store LRU:** not reachable in a harness run of any length short of a week. A body whose route was used
  within `PINNED_FOR` (7 days, `share.rs`) is pinned, and every body in a run is used within minutes. A tiny
  `storage_gb` on one node was tried and taken out again: it only cost that node coverage. Reaching it needs the node
  clock moved forward (Antithesis can't either without that). `store::over_bound` has no unit test by name: a gap.
- **R1.28:** filed as issue #199, to land after #197 and #198, which both rewrite `LeanSettlement.sol`.
- **Measured (2026-11-04):**
  - Confirming explore: 4 runs, 0 failures, 28 reached, 8 on the frontier.
  - Cut-heavy soak (seed 3030, 6 cuts, 1 crash, 10 min): passed. The registry-read and hold-bookkeeping assertions
    were still not reached. Six chain cuts did not get there, so a cut alone is not their trigger. Not diagnosed yet:
    when a node reads the registry for a peer (probably only when a new peer connects), and when the background pass
    sends a hold.
