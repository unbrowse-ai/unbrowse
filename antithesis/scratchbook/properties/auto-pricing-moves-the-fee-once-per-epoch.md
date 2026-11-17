# auto-pricing-moves-the-fee-once-per-epoch

**Focus:** 3 Failure Recovery. **Confidence:** medium-high. **Status:** suspected defect. The mechanism is confirmed by code reading but was not run end to end.

## Property

With auto pricing on, the node changes its on-chain fee (`setFee`) at most once per epoch on its own. Over an epoch
the fee moves by at most one step of `Pricing::next_fee`: up a tenth, down a tenth, or halfway to the market.

## Claimed guarantee

- `main.rs:586` (doc on `reprice`): "Once an epoch, an auto-priced node moves its fee with the paid fetches its routes
  drew since the last look."
- `store.rs:506-508` (`next_fee`): "The next epoch's fee: up a tenth when more paid fetches came than the epoch
  before ..."

## Code path (`main.rs:587-611`)

1. `p = load_pricing()`. If `epoch <= p.epoch`, it returns: the per-epoch gate.
2. `paid_since(p.block)`, `fee_of`, `market_fee`, then `next = p.next_fee(fee, lines, market)`.
3. `chain::set_fee(next).await?` (`:604`, `send!`: send then `get_receipt`).
4. Only after that: `p.epoch = epoch; p.block = block; p.lines = lines; save_pricing(&p)` (`:607-610`).

If step 3 lands on chain but returns `Err`, or the process dies between 3 and 4, `p` is unchanged. The next pass, a
minute later, passes the gate again. It reads `fee_of` = the **new** fee, gets the same `lines` from the same
`p.block`, and calls `next_fee(new fee, same lines)`, which moves again. Each such failure compounds the step: ×1.1,
×1.21, ... up to `ceiling`, or ×0.9 ... down to `floor`.

Ways to get there:
- `get_receipt()` errors after the tx was mined (a connection drop while polling).
- `send()` errors after the node accepted the tx (the response is lost).
- Kill -9 or an update `hand_over` exec between `:604` and `:610`.
- `save_pricing` fails on a full disk (the atomic write fails, see `probe_a_full_disk`) after `setFee` succeeded. The
  fee then moves every minute until space returns.

## Why it matters

The fee decides what every caller pays and whether this contributor's routes rank (`rank::ranked` sorts by fee,
`network.rs:167`). A run of faults during one epoch can drive the fee to the ceiling (callers overpay or go elsewhere)
or to the floor (the contributor underearns), against the once-per-epoch claim.

## Antithesis angle

Node-to-chain faults with asymmetric loss (requests arrive, responses lost) while `singleton_driver_epoch` crosses
epochs. Node termination helps but isn't required. A disk-full custom fault gives the every-minute variant.

## Instrumentation (none exists)

- Workload, **missing** (`anytime_`): from `FeeSet(contributor indexed, fee)` logs (`LeanSettlement.sol:230,726-729`),
  per contributor per epoch (block number / epochBlocks), excluding txs the driver caused (it logs the tx hashes of
  its `set_pricing` calls): `Always(count <= 1)`. Also `Always(fee_after / fee_before within [0.9, 1.1] or the
  halfway-to-market move)`.
- SUT, **missing**: in `reprice`, `AlwaysOrUnreachable("auto pricing sets the fee once per epoch")`. Keep the last
  epoch whose `setFee` was sent in a process-static, plus the `pricing.json` epoch. This catches the in-process retry
  path. The cross-restart path needs the workload check.
- SUT, **missing**: `Reachable("reprice setFee failed after send")` on the `Err` from `set_fee`.

## Open questions

- Should `p.epoch` advance before `setFee`, or should reprice read the epoch's earlier `FeeSet` log, to be
  idempotent? It affects whether the SUT-side assertion can be exact.
- Does `set_pricing` (owner) interplay matter? It writes `pricing.json` after its own `setFee` (`main.rs:577-581`),
  with the same ordering.
