# passed-lines-are-claimed-within-their-window

**Focus:** 1 Data Integrity (value owed vs value paid), 9 Idempotency (retry until done). **Confidence:** medium. **Status:** liveness guarantee to test; several mechanisms found by code reading.

## Property

Every passed line a node signs, which the payer's deposit and the key's cap cover, is spent on chain before its claim window closes, provided the payer's node and the chain were both up for at least one full claim pass after the line was written.

## Claimed guarantee

- protocol.md R3.28 "Payees SHOULD claim within 2 epochs"; R3.23 "every payee is paid in full" when covered.
- `api.rs:850` "this node's next claim pays it"; `main.rs:671-673` "One claim that fails doesn't hold up the others."
- Contract window: a voucher for epoch e is claimable through e+1 (`LeanSettlement.sol:109-112,924-925`).

## Code path and mechanisms

- Claim loop: `main.rs:1438-1453` every 60 s, in sequence `claim_all`, `reprice`, `hold_tick`. `claim_all` (`main.rs:674-695`) claims epochs e-1 and e for every agent, then `claim_owed`.
- **No timeouts:** every write is `send().await` then `get_receipt().await` (`chain.rs:618-627`) over a default reqwest client. One hung RPC stalls claims for every agent until the process restarts (sut-analysis §5.7).
- **Blocked streams:** see `one-unpayable-line-never-blocks-the-rest`.
- **Epoch fallback:** own-entry lines take `current_epoch(...).unwrap_or(0)` (`api.rs:839`). An RPC error at that instant files the line under epoch 0 (`receipts/<agent>-0.json`), which `claim_all` never claims. `covers(0, ...)` also counts every unclaimed line ever (`chain.rs:1192`, `e + 1 >= 0`), so the line is likely refused instead, after the site call (see `cap-is-checked-before-the-site-is-called`). Either way the use is unpaid.
- **Contributor's own claim can't step in across machines:** `send_receipt` finds the contributor through the local ad folder and a `127.0.0.1` endpoint (`network.rs:402-404,76`), and the API refuses non-loopback Host headers. In a multi-container topology owed lines never arrive, so only the payer's node can claim.
- **Owed lines under an older voucher:** a contributor holding line L0 under voucher V1 can't claim it once a later line of the stream was claimed under V2: `claimed > V1.cumulative`. Probe `MoneyProbe.t.sol::test_probe_olderVoucherRefusedAfterNewerClaim` passes (revert `OverCumulative`; the same line under V2 pays). `claim_owed` keeps such a line until the window closes (`chain.rs:1524-1528`), relying on the payer.

## Failure scenario

The chain RPC blackholes for a minute while the claim loop is inside `get_receipt()`. It never returns (TCP keeps the connection); the node keeps answering calls through fresh providers, writing lines nobody claims; the window closes; contributors are unpaid for that epoch.

## Antithesis angle

This is a "recovers after faults" property. Workload: drive paid calls, inject chain partitions/latency and node restarts, then pause faults, wait for two claim passes (> 120 s), and only then advance the chain clock past the window with `evm_increaseTime`. Antithesis controls the timing of the faults relative to the 60 s loop and the window edge.

## Instrumentation (all missing)

- Workload `Always("every covered passed line is spent before its window closes")`: evaluated right before the workload advances the clock past e+1, after a quiet period; lines read from the payer node's owner API (receipts) or from activity, checked with `spentLine`. Missing.
- SUT-side `Unreachable("a paid line is filed under epoch 0")` in `push_receipt` when `epoch == 0` and the chain's epoch isn't 0. Missing.
- SUT-side `Sometimes("a claim pass completes after a chain fault healed")` in `claim_all` (success after a prior error). Missing.

## Open questions

- Is the payer's own claim the intended only path on a multi-machine network, with `owed.json` a single-machine feature? If so, the contributor has no recourse when the payer's node is gone, and the property is "payer-up" conditional by design.
- Should the claim loop bound each RPC (timeout) so a hang can't outlast a window? The fix changes whether the property can hold under blackhole faults at all.
