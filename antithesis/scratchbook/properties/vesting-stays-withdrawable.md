# vesting-stays-withdrawable

**Retired (route coins, 11 November 2026):** nothing vests; a contributor's route share is owed by `CoinFetch` and taken whole. The workload now checks `the-route-share-stays-withdrawable` (`CoinFetch.withdraw` fits a block for every contributor it owes). What follows is the record of the vesting-era property.

**Focus:** 1 Data Integrity (funds reachable), with 5 Resource Boundaries. **Confidence:** high (measured). **Status:** confirmed defect (gas probe); live gas limit unknown.

## Property

An earner can always withdraw what has vested: `withdrawVested()` (and the `vestedOf`/`vestingOf` views the node reads first) fit in one transaction however many claims the earner has received.

## Claimed guarantee

- protocol.md R6.14 "Each claim, in USDC, is withdrawable 14 epochs after it is made. Vested claims are never clawed back."; economy.md §9 vesting.

## Code path

- Every claimed line pushes one `Vest` per earner it pays: `_earn` -> `_vest` (`LeanSettlement.sol:701-702,1001-1004`); holders each get one too (`_payHolders` -> `_earn`, `:993-995`).
- `withdrawVested` (`:1008-1024`) walks the whole array, vested and unvested, swap-removing vested ones; all-or-nothing, no bound, no partial withdraw. `vestedOf`/`vestingOf` (`:1027-1042`) walk it too, and the node calls `vestedOf` before sending (`chain.rs:1606`).
- Unvested entries can't be removed, so 14 epochs of claims are always in the array.

## Discriminating evidence

`scratchpad/money-probe/test/lean/MoneyProbe.t.sol` (`vm.cool` before the call so storage is cold, one claim line per entry):

- `withdrawVested gas, 200 entries: 2,544,659`
- `withdrawVested gas, 1000 entries: 12,461,459` (linear, about 12.4k gas an entry)
- `test_probe_vestGas_2500`: `withdrawVested{gas: 30_000_000}()` **reverts** (out of gas).

So an earner with about 2,400 entries cannot withdraw under a 30M block gas limit. At the contract's one-entry-per-line rule that is about 170 paid lines a day sustained over the 14-epoch window, and since the loop includes unvested entries, a busy earner stays locked as long as it keeps earning.

## Antithesis angle

Weak timing interest; the value is a sustained-load workload that counts entries and checks the bound continuously, so the threshold is found under realistic claim mixes (holders double the entries per line).

## Instrumentation (all missing)

- Workload `Always("each earner's withdrawVested fits the block gas limit")`: `eth_estimateGas` of `withdrawVested` from each earner (or count `Vesting` events minus `VestedWithdrawn` coverage) compared with the chain's block gas limit. Missing.
- A Foundry invariant test with a bounded handler would show it too.

## Open questions

- Arc's block gas limit and eth_call gas cap (the views loop as well). 30M is Anvil's default; a higher limit moves the threshold, not the shape.
- Is batching vests per epoch (one entry per earner per epoch) acceptable under the fraud-clawback design? It would bound the array at 14 entries.
