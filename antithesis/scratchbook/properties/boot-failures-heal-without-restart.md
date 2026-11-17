# boot-failures-heal-without-restart

**Focus:** 8 Lifecycle Transitions, 3 Failure Recovery. **Confidence:** high. **Status:** confirmed by code reading. Each branch is unconditional. Not run end to end.

## Property

A node that boots while its chain link is faulty reaches the fully-up state once faults stop, without a restart. The
fully-up state: chain started, Settlement deployment found, claim loop running, and peer network joined (`node.net`
set, its address published).

## Code paths, each a one-shot

1. **Chain start error, task ends** (`main.rs:1404-1436`). `chain.start()` -> `start_live` -> `check_rpc` (10 s,
   `chain.rs:135-142`), or `network_file`. On `Err` the task sets `chain_error` and `return`s (`:1433-1437`). Nothing
   restarts it: no claims, no peers, no pricing, until the process restarts. `chain_status` (`main.rs:457-469`) shows
   the error for good.
2. **Settlement not found, forever** (`chain.rs:390-412`). `usable()` does `get_code_at` (no timeout). A transport
   error there becomes `found = Err(..)`, then `unavailable = Some(why)` and `Ok(None)`. `deployed()` is `Err` for the
   process's life, and nothing calls `start_live` or `usable` again. The claim loop spins on `deployed().is_err()` every
   2 s (`main.rs:1441-1443`). Every paid call, voucher check, listing and claim fails with the boot-time reason.
3. **Peer network join error, no retry** (`main.rs:1425-1430`). `peers::start` can fail on `erc8004::ensure` (chain
   reads and two txs), `registry_from`, `peer_port`, `key_for` (a disk write), `Net::start_with_bodies`, or the first
   `publish` (`peers.rs:356`, `?`). It is logged once. `n.net` is never set. When the failure comes after `Net::start`
   (step `publish`), a swarm runs with no handle; that half is `node-on-network-after-first-publish-fails` (another
   focus). The concurrency probe in `one-erc8004-identity-per-owner` shows `ensure`'s first caller failing with `nonce
   too low` whenever an owner `list_route` overlaps it at boot, which is this branch with no network fault.
4. **Owner token on a full disk** (`main.rs:1367-1373`, `api.rs:1183-1197`): `remove_file` then `create_new` +
   `write_all`. On error the process exits 1. Probe (`life-probe/.../update.rs::probe_a_full_disk`, 4 MiB HFS+ RAM
   disk filled): with no token file, `owner_token -> Err(.. code: 28, StorageFull ..)`. With an old token file to
   remove, it succeeded (its block was reused). A node whose `/data` is full may not boot at all.

Only `network_on()` turning true is waited for (`main.rs:1416-1418`), and only the join step re-reads it.

## Why it matters

In the topology every node boots at once while the chain container is still deploying or healthy-checking. A node that
starts first runs without Settlement and never re-checks (deployment-topology.md item 2 already warns about this).
Under Antithesis node-to-chain faults at boot, and after every node termination and restart, a node can stay half-up
for the rest of the run. Every later property then fails for a reason unrelated to what it tests.

## Antithesis angle

- Node-to-chain partition or latency over 10 s during the first seconds after a node (re)starts.
- Chain container hang at boot.
- Node termination to re-run boot many times; this needs node termination enabled.
- A full `/data` (custom fault) for item 4.
- Liveness checks after `ANTITHESIS_STOP_FAULTS`: the owner's `chain_status` reports `up` with a deployment and no
  error, the node answers lookups for node-1's site, and its claim loop has run.

## Instrumentation (none exists)

- SUT, **missing**: `Reachable("chain start failed at boot")` at `main.rs:1434`, `Reachable("Settlement unusable at
  boot")` at `chain.rs:408`, `Reachable("peers::start failed")` at `main.rs:1429`. They show the faults reached the
  one-shots.
- SUT, **missing**: `Sometimes("node fully up after a boot-time chain failure")`. It is unreachable today, so it flags
  the missing retry.
- Workload, **missing** (`eventually_node_fully_up`): for each node, `chain_status.up && chain_status.error == None`,
  and the node's peer id appears in another node's table (or a lookup from it succeeds), `Always` after a quiet
  period.

## Open questions

- Should item 2 treat a transport error differently from "no contract at the address" (which is permanent until
  `chain deploy`)? The answer decides whether the fix is a retry loop or a re-check on each `deployed()` miss.
- On ext4, does `owner_token` fail on a full disk when an old token exists? Freed blocks may not be reusable until the
  journal commits. The probe ran on HFS+ only.
