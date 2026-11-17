# settlement-usdc-equals-its-liabilities

**Now (route coins, 11 November 2026):** `usdc.balanceOf(S) == Σ account.balance + Σ escrow[domainHash] + burnBuffer + heldRoute`, as `invariant_settlementUsdcEqualsItsLiabilities` has it; nothing vests. Beside it the workload checks `the-fetch-holds-exactly-what-it-owes` (`CoinFetch`'s USDC equals its `accounted`). What follows is the record of the vesting-era property.

**Focus:** 1 Data Integrity. **Confidence:** high. **Status:** confirmed defect (probe). Same root cause as `settlement-unb-covers-every-bond`, the other token's side.

## Property

Every unit of USDC LeanSettlement holds belongs to someone: `usdc.balanceOf(S) == Σ account.balance + Σ escrow[domainHash] + Σ_w (vestingOf(w) + vestedOf(w))`. Nothing is stranded with no function that can pay it out.

## Code path

- USDC enters only by `deposit` (`LeanSettlement.sol:311-316`).
- USDC leaves only by `withdraw` (`:331-342`, from `balance`), `claimEscrow` (`:847-857`, from `escrow`), `withdrawVested` (`:1008-1024`, from `_vesting`), and inside `_claim` the platform cut and burn (`:959,966`).
- `_claim` moves `amount` out of `balance` and splits it into escrow (30%), platform (sent), holders and contributor via `_earn`, burn (sent) (`:947-966`).
- `_earn` (`:694-702`) turns `w` of the share into `_bond.filled` (a UNB number) and only `amount - w` into `_vesting`. So `w` USDC stays in the contract and appears in no USDC ledger.

## Discriminating evidence

`scratchpad/money-probe/test/lean/MoneyProbe.t.sol::test_probe_withheldUsdcIsStranded` (`forge test --match-contract MoneyProbe --match-test probe_withheld -vv`):

```
USDC held by contract:                        998.5e18
USDC liabilities (deposits+escrow+vesting):   995.75e18
withheld into UNB bond:                        2.75e18      (assertEq(held - liab, filled) passes)
USDC held after unbond and vested withdraw:  995.75e18
```

After the wallet unbonded (taking UNB) and withdrew its vested 2.75, the contract still holds 2.75 USDC more than every liability. There is no function that can move it.

## Failure scenario

Every claim to a wallet short of its target strands half the contributor's 55% (and of any holder's share, if the holder joined). Over time, the contract accumulates USDC that no one can withdraw while paying out UNB it never received (the sibling property).

## Antithesis angle

Same workload as the UNB property. The equality is cheap to check after every step and catches any future path that leaks or strands USDC: rounding in `_payHolders` (dust goes to burn), escrow for unbound domains (still a liability, counted), claims racing a withdrawal (`:947-950`).

## Instrumentation (all missing)

- Workload `Always("settlement USDC equals deposits plus escrow plus vesting")`: equality, not `>=`; any surplus is the defect. The workload must track the set of earners (from `Vesting` events) and domain hashes (from `EntryListed`). Missing.
- Workload `Sometimes("a claim withholds part of a share into a bond")` on `BondWithheld` events, so the run is known to have reached withholding. Missing.

## Open questions

- If the owner intends withheld USDC to be swapped off-contract, which actor sweeps it and how does the contract know which USDC is withheld? Today nothing records it as USDC; the answer decides whether the invariant is "equality" or "equality plus a recorded withheld pool".
