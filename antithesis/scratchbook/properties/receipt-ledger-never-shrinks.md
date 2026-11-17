# receipt-ledger-never-shrinks

**Focus:** 3 Failure Recovery, 5 Resource Boundaries. **Confidence:** high on the mechanism, low-medium on reachability. **Status:** confirmed defect by scratch probe (commit 91115204).

## Property

An agent's receipt file for an epoch only grows. A line once written, signed or not, is never removed or overwritten.
Line indexes stay unique and dense, and the cap check counts every pending line in the file.

## Claimed guarantee

- `chain.rs:1147-1150` (`LEDGER`): "a claim that waited on the chain merges what it learned into the file as it stands
  then, so a line written while it waited is never written over."
- `chain.rs:1168-1169`: "The cap and the deposit are enforced here, before anything is signed (FR-2)."
- `store.rs:66-68` (`read_json_strict`): "a file whose contents decide who may do what: a file that is missing is
  empty, but one that is there and doesn't read is an error, never read as empty". The receipt files do not use it.

## Code paths

- `chain::receipts` (`chain.rs:1143-1145`) = `store::read_json` (`store.rs:60-62`): **any** read or parse error,
  not only "not found", becomes `Vec::new()`.
- `edit_receipts` (`chain.rs:1160-1166`): reads under `LEDGER`, applies the change, and writes back with
  `store::write_json` (tmp file then rename, which replaces the file whole).
- `push_receipt` (`chain.rs:1215-1250`): `pending` is summed over the read lines, so 0 when the read failed, and the
  new line takes `index = all.len()`, so 0.
- Same pattern for `owed.json` (`owe`, `forget_owed`, `chain.rs:1503-1523`), `held.json`, `pricing.json` and
  `settings.json` (`load_settings`, read on every check: a read error gives default settings, `peer_network: true`,
  empty `excluded`, and an owner `save_settings` then writes those defaults back).
- `covers()` reads every receipt file of epochs e-1 and e with the same lenient read (`chain.rs:1185-1211`).

## Probe (scratch copy, not the repo)

`life-probe/unbrowse-node/app/src/chain.rs`, test `probe_a_receipt_file_that_fails_to_read_is_rewritten_as_one_line`:
three lines of 1.0 under a cap of 3.0, and a 4th is refused. Then the file is made unreadable (mode 000, standing in for
EACCES/EMFILE/EIO), and a 4th `add_receipt` is called:
`4th add while unreadable -> Ok(0); file now holds 1 line(s), indexes [0]`.
So the cap check passed, the new line took index 0, and three signed lines were replaced.

## Consequences

- Lines already in a signed running voucher (and maybe sent to the contributor as a `PaidLine`) disappear from the
  payer's ledger, so its own claims never pay them.
- A new line reuses index 0. A voucher over the new file has a different root. The contributor's `owed.json` copy of
  the old index-0 line was signed under the old root and stays claimable until spent.
- The cap check undercounts, so a passed line can go past the cap. Its claim then reverts `OverCap` (a
  `no-passed-line-past-the-cap` style outcome).

## Reachability

Atomic rename means a crash never leaves a torn receipt file, and Antithesis doesn't model power loss, so the trigger is
a read that fails while the file exists:
- fd exhaustion (EMFILE) in the node process. Every chain call builds a fresh HTTP client and connection
  (`ProviderBuilder::new()` per call across `chain.rs`/`erc8004.rs`). A burst of lookups (`listing::verify`, 3 reads
  per listing) plus libp2p connections and many concurrent agent calls makes it plausible, unproven.
- an EIO or permissions fault from a custom fault script.

## Antithesis angle

A custom fault that lowers the node's `RLIMIT_NOFILE` (prlimit) or chmods a receipt file for a moment, while
`parallel_driver_call` runs paid calls. Node termination isn't needed.

## Instrumentation (none exists)

- SUT, **missing**: in `edit_receipts`, `Always("a receipt file read as empty only when it is absent")`, i.e.
  assert `!path.exists()` whenever `receipts()` returned empty. Or, better, assert on a high-water mark: a
  process-static map (agent, epoch) -> max len written, and `Always(all.len() >= high_water)` before the write.
- SUT, **missing**: `Always("receipt indexes are 0..n")` after each `push_receipt`.
- Workload, **missing**: `finally_`: for each caller, the count of passed lines per (agent, epoch) it observed from
  call results is <= the lines in that agent's receipt file (exposed through an owner command, or by reading `/data`
  in the node container).

## Open questions

- Is fd exhaustion reachable in the topology's workload, i.e. how many fds does a node hold at peak (libp2p
  connections + per-call reqwest clients + Chrome none)? It decides whether this needs a custom fault or can arise on
  its own.
- Should `receipts()` use `read_json_strict` (error, not empty), as the listing book and `agents.json` do? The
  claimed rule at `store.rs:66-68` suggests yes.
