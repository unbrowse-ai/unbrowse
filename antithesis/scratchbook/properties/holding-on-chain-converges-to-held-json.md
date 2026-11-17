# holding-on-chain-converges-to-held-json

**Retired (route coins, 11 November 2026):** holding is no longer written to the chain (`RouteStakes.holdRoute` went with route stakes); `held.json` is the whole record, so there is nothing on chain for it to converge to. `eventually_network_recovers.py` no longer checks it. What follows is the record of the earlier property.

**Focus:** 3 Failure Recovery, 2 Concurrency. **Confidence:** high. **Status:** confirmed defect. The release-failure path was shown by a scratch probe. The crash path is confirmed by code reading of node and contract.

## Property

Once faults stop and one `hold_tick` has run, the set of entries the node holds on chain (`holding[owner][entry]`)
equals the set in `held.json`. With `hold_routes` off, both are empty.

## Code paths

- `peers::hold_tick` (`peers.rs:437-514`), from the claim loop every 60 s (`main.rs:1451`):
  - Holding off (`:441-448`): for each held entry, `let _ = chain::hold_entry(.., false)`. **The error is dropped.**
    Then `store::save_held(&[])`. The node forgets every hold whether or not the release reached the chain.
  - Holding on (`:465-492`): `holdRoute` per new route. The entry is pushed to the in-memory `held` only if the tx
    succeeded. `save_held` runs once, **after the whole loop** (`:503-505`), after possibly many txs and `find()`
    lookups (each up to 3 chain reads per listing, no timeout).
  - Over the cap (`:494-502`): `let _ = hold_entry(.., false)` per dropped entry, error dropped, then saved.
- `chain::hold_entry` (`chain.rs:1020-1027`): `send!` of `holdRoute`/`releaseHold`.
- Contract (`LeanSettlement.sol:774-785`): `holdRoute` reverts `AlreadyHolding` if already held. `releaseHold`
  reverts `NotHolding`.
- `held.json` has no lock (sut-analysis §3), and its only writer is `hold_tick`.

## Failure scenarios

1. **Release fails, record dropped.** Any `releaseHold` failure: an RPC fault, a nonce collision with a concurrent owner
   write (`owner-key-writes-never-share-a-nonce`, shown to happen 10/10), or a gas shortfall. `held.json` becomes `[]`,
   and the chain keeps `holding = true`. Nothing will ever release it: the node only releases what `held.json` lists.
2. **Crash between `holdRoute` and `save_held`.** On restart `held.json` lacks the entry. The next tick finds the
   route again and calls `holdRoute`, which reverts `AlreadyHolding`, so `is_ok()` is false and the entry is never added.
   The node is a holder on chain but neither serves the listing (`ServedListings::site` reads `held.json`,
   `peers.rs:154-163`) nor releases it when holding is turned off. Same if `save_held` fails on a full disk (the
   atomic write fails, `life-probe/.../update.rs::probe_a_full_disk`).
3. `holdRoute` mined, then `get_receipt()` errors: the same as 2, without a crash.
4. Update hand-over (`update.rs:192-206`) mid-tick is a crash for this purpose: `IN_FLIGHT` counts API requests only.

## Probe (scratch copy, not the repo)

`life-probe/unbrowse-node/app/src/peers.rs`, test `probe_holding_off_forgets_holds_whose_release_failed`: `held.json`
holds one entry, `hold_routes = false`, and the RPC port refuses connections. A direct `hold_entry(false)` returns
`Err("error sending request for url ...")`. After `hold_tick`: `held.json after hold_tick with holding off: 0
entr(ies)`. The node dropped a hold it never released.

## Why it matters

The chain's `holding` decides who shares the 5% serving share (`_payHolders`, `LeanSettlement.sol:973-997`) and
whether a payer's own lines name this node (`running_voucher`, `chain.rs:1348-1350`). A node that drifted keeps
`holding = true` and is named a holder on its own lines, though the owner turned holding off. The owner can't see or fix
it from the node. The node also takes on a holder role it never serves.

## Antithesis angle

- Node-to-chain partitions or latency during `hold_tick`, while the driver toggles `hold_routes`.
- Concurrent owner commands (nonce collision) with no network fault.
- Node termination between `holdRoute` and the end of the tick, which may be seconds later.
- Disk-full custom fault on `/data`.

## Instrumentation (none exists)

- Workload, **missing** (`anytime_local_vs_chain` after `ANTITHESIS_STOP_FAULTS` and > 60 s): for node-2, read
  `held.json` (or an owner command that returns it) and `holding(owner, entry)` for every entry ever held (from
  `HoldStarted` logs for the owner) and assert `Always(chain set == held.json set)`.
- SUT, **missing**: at `peers.rs:441-448`, `Unreachable("holding off forgets a hold whose release failed")` on the
  error branch of `hold_entry(false)`.
- SUT, **missing**: at `peers.rs:471`, `Unreachable("holdRoute refused as already holding an entry held.json lacks")`
  on an `AlreadyHolding` revert.
- SUT, **missing**: `Sometimes("hold_tick saved after holding a route")`, so the success path is seen.

## Open questions

- Should `hold_tick` rebuild its set from `HoldStarted`/`HoldReleased` logs (the chain as the source), or keep
  `held.json` and retry failed releases? The answer decides whether the assertion compares against `held.json` or
  against the node's reported holdings.
- Is `holding` meant to be set for a node's own entries (`running_voucher` names `me` when it holds its own route)? If
  not, scenario 2 also mis-names lines.
