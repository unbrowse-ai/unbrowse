# one-unpayable-line-never-blocks-the-rest

**Focus:** 1 Data Integrity, 9 Idempotency/Replay (retried claim passes). **Confidence:** high for the mechanism; the trigger depends on `no-passed-line-past-the-cap` or a backlog. **Status:** confirmed (contract half by probe, node half by code reading).

## Property

A claim pass pays every line that can be paid. A line the contract refuses (over the cap), or a backlog too large for one transaction, never stops the other payable lines of the same agent and epoch from being claimed within their window.

## Claimed guarantee

- `chain.rs:1376-1377` "A line its payee already claimed is marked claimed and skipped; one the deposit no longer covers is left for a later try."
- `chain.rs:1390-1391` "The batch is all or nothing, so it carries only lines the deposit covers, in order, and that each claim alone: **one line the chain refuses would otherwise keep every other from being paid**."
- protocol.md R3.23 "when the deposit covers what was signed as passed, every payee is paid in full"; R3.26 batches through a relayer.

## Code path

- `chain.rs:1378-1442` `claim()`: builds `todo` from every open line. For each it simulates `s.claim(line).call()` **alone** against current state and accumulates only `room` (the deposit, `:1392-1400`). It never accumulates the cap, nor the batch's gas.
- `:1417-1425` sends one `claimBatch` with every `todo` line; `send!` (`:618-627`) returns `Err` from `claim()` when gas estimation reverts or the receipt fails; `mark` (`:1428`) is never reached; the next pass rebuilds the same batch.
- Contract: `claimBatch` is all-or-nothing (`LeanSettlement.sol:893-910`); `_claim` refuses a line once the stream's claimed total passes the cap (`:939-942`).
- Contrast `claim_owed` (`chain.rs:1550-1576`), which falls back to one-by-one when the batch simulation fails. `claim()` has no fallback.

## Discriminating evidence

`scratchpad/money-probe/test/lean/MoneyProbe.t.sol::test_probe_overCapBatchBlocksPayableLines` (passes): cap 10, three lines of 4 under one voucher (cumulative 12). Each line alone claims (snapshot/revert); the batch of three reverts `OverCap` with `claimedOf == 0`; a batch of the first two succeeds (`claimedOf == 8`). The node would always send the batch of three.

Gas, same file (`vm.cool` so storage is cold): `claimBatch gas, 64 lines, no holders: 6,934,092` (about 108k a line) and `64 lines, two holders: 14,008,301` (about 219k a line). At Anvil's default 30M block gas limit one batch fits about 275 lines with no holders, about 135 with two holders. `claim()` never splits a batch.

## Failure scenario

1. An over-cap line exists (race in `no-passed-line-past-the-cap`). Every 60 s the node retries the same reverting batch; every line of that agent and epoch, including those claimed alone would pay, stays unpaid until the window closes (`CLAIM_WINDOW = 1`, `LeanSettlement.sol:112`). Contributors lose a day of fees.
2. The chain is unreachable or the claim loop is stuck (no RPC timeouts, sut-analysis §5.7) while calls continue (or the stream is blocked by case 1, so lines pile up). Once more than about 135-275 lines are open, the batch exceeds the block gas limit and never lands.

## Antithesis angle

Case 1 needs the cap race plus a retrying loop: Antithesis explores the ordering. Case 2 is a chain partition or slow RPC during sustained load, then heal: exactly the "recovers after the fault" question. The invariant should be checked after faults stop and two claim passes have run.

## Instrumentation (all missing)

- Workload `Always("after quiescence every individually payable line of a stream is spent")`: after faults pause and two claim passes, for each (agent, epoch) still in window, every passed line that simulates OK alone given the lines before it is `spentLine`. Missing.
- SUT-side `Unreachable("a claim batch reverted although each of its lines simulated alone")` at the `send!` error in `claim()` when every `todo` line passed its `.call()`. Missing.
- SUT-side `Sometimes("a claim pass sends a batch of more than 100 lines")` to show the backlog state was reached. Missing.

## Open questions

- What is Arc's block gas limit (and the RPC's `eth_estimateGas` cap)? It sets the backlog size at which case 2 bites; the 30M figure is Anvil's default.
- Should `claim()` drop to one-by-one like `claim_owed`, or pre-accumulate the cap like `room`? Either satisfies the property; the second also keeps the batch at one transaction.
