# settlement-unb-covers-every-bond

**Retired (route coins, 11 November 2026):** there is no bond, so Settlement holds no UNB at all. The workload now checks `settlement-holds-no-unb` (`helper_invariants.py`, after `invariant_settlementHoldsNoUnb` in `unbrowse-settlement/test/lean/Invariants.t.sol`). What follows is the record of the bond-era property.

**Focus:** 1 Data Integrity (with 6 Security Boundaries). **Confidence:** high. **Status:** confirmed defect (probe).

## Property

The UNB that LeanSettlement holds always covers the UNB it owes: `unb.balanceOf(settlement) >= Σ_w (_bond[w].filled + _bond[w].unbonding)`. No wallet can unbond more UNB than it, or the pool on its behalf, posted.

## Claimed guarantee (leads, validated against code)

- economy.md:89 "the contract withholds 50% of each USDC claim, **swaps it into the bond**"; protocol.md R6.8 "withheld, swapped for UNB through the pool and locked in the bond"; R6.9 "Withheld UNB stays the wallet's and is released after unbonding (R6.14)".
- The contract has no pool and no swap.

## Code path (sut_path-relative)

- `unbrowse-settlement/src/lean/LeanSettlement.sol:675-703` `_earn`: `w = Bond.withheld(amount, filled, target)` with `amount` a **USDC** share; then `_bond[who].filled += w` (UNB units). Comment `:676-677`: "On devnet the withheld USDC fills the bond at par — mainnet swaps it ... above this contract." Nothing above the contract exists in the repo.
- `:506-519` `requestUnbond`: allows `filled - target`; `:522-531` `unbond`: `unb.safeTransfer(msg.sender, amount)`.
- `:586-601` `_foldBase`: the base folds to the lowest close; quiet epochs fall to `bondFloor`, so the target drops and withheld "UNB" becomes excess.
- The node deploys this same contract to live networks: `unbrowse-node/app/src/chain.rs:548-565` (`deploy_shared` -> `deploy_as`, `:516-542`).
- The repo's own test books it at par: `unbrowse-settlement/test/lean/Settlement.t.sol:1083-1107` `test_zeroStart_withholdsHalfIntoBond` asserts `filled1 + earned == 5.5 ether`.

## Discriminating evidence

Competing explanation: "the probe misconfigures the contract or the target never really drops." Ruled out:

1. Stage-1 probe, re-run here: `scratchpad/settle-probe` (src identical to the repo's, `diff -r` clean), `forge test --match-test probe -vv`:
   `filled by withholding: 10e18`, `UNB paid to a wallet that posted none: 8e18`, `UNB the contract holds: 12000000000000000040`, `UNB owed to contributor+contributor2+freshc: 22e18`. The contract is short by 10 UNB after one wallet leaves.
2. My own probe, `scratchpad/money-probe/test/lean/MoneyProbe.t.sol::test_probe_withheldUsdcIsStranded`: one 10-USDC line, 2.75 withheld, 40 quiet epochs, unbond: `UNB the fresh wallet received (posted none): 0.75e18` (filled 2.75 minus the 2.0 floor).

Both use the repo's constructor values pattern (floor 2, open 10, unbond 30) and only public entry points.

## Failure scenario

A zero-bond contributor earns claims (bond fills by withholding), joins quiet down, then `requestUnbond` + `unbond`. It receives UNB that other wallets posted. With enough such wallets, a wallet that posted real UNB finds `unbond` reverting on `safeTransfer` (insufficient balance). Its UNB is gone.

## Antithesis angle

Not a timing bug: it needs a workload that (a) lists from zero, (b) gets claims, (c) advances the chain clock through quiet epochs (`evm_increaseTime`), (d) unbonds. Antithesis's value is exploring the order of joins, claims, postBond top-ups and unbonds across three owners and the bond-price path (join waves raise the price; quiet epochs fold the base). The invariant is a pure chain read, so it can run after every workload step.

## Instrumentation (all missing; no Antithesis SDK in repo, see existing-assertions.md)

- Workload `Always("settlement UNB balance covers every filled and unbonding bond")`: read `unb.balanceOf(S)` and, for each known wallet, `bondOf(w).filled + unbonding`. Missing.
- Workload `Sometimes("a wallet unbonds stake that withholding filled")`: reached when a wallet whose posted UNB (from `BondFilled` events) is less than its `Unbonded` total. Missing. This is the anchor that shows the dangerous state was explored.
- A Foundry `invariant_` test would catch this too (none exist).

## Open questions

- Is at-par booking an accepted devnet simplification, given `chain deploy` puts the same bytecode on live networks? If yes, the property is scoped to "live deployments must not use this contract"; if no, the contract needs a pool swap or a separate USDC ledger for withheld amounts. (stage-1 already asked; still needs the owner)
