# no-passed-line-past-the-cap

**Focus:** 1 Data Integrity, 6 Security Boundaries. **Confidence:** medium-high (race by code reading; not reproduced). **Status:** suspected defect D5, validated mechanism.

## Property

For every agent key and voucher epoch, the passed lines the node signs never add up to more than the key's cap for that epoch: `claimedOf(payer, agent, e) + Σ unclaimed passed lines(agent, e) <= termsFor(payer, agent, e).cap`. A line the contract would refuse with `OverCap` is never written.

## Claimed guarantee

- `chain.rs:1168-1169` "The cap and the deposit are enforced here, before anything is signed (FR-2)"; `:1200-1201` "A line past the deposit would make the claim carrying it revert."
- protocol.md R1.22 "The contract pays no line from a voucher signed by a key beyond the key's cap."

## Code path

- `push_receipt` (`chain.rs:1215-1248`) checks `spent + pending + amount > cap`, with `pending` from the file under `LEDGER` but `spent` passed in by the caller.
- `spent` is read long before: `api.rs:744` (network call, before fetch and site call) and `api.rs:809` (own entry, before the site call), from `agentOf().spentThisEpoch` = `_claimed[payer][agent][epoch()]` (`LeanSettlement.sol:418-425`).
- The claim loop (`main.rs:1438-1453`, every 60 s) mines a batch and then marks those lines `claimed` (`chain.rs:1403-1428`).

**Race 1 (claim lands mid-call):** spent read = S; claim of X mines and marks X claimed; `push_receipt` sees pending P-X. Check uses S + (P-X) + a; the truth is S + X + (P-X) + a. Undercount X.

**Race 2 (epoch rolls mid-call):** `call_entry` reads `epoch = e` at `api.rs:737`, then `agent_spend` at `:744` reads `_claimed[..][epoch()]` which may already be e+1 (about 0). The line is filed under e (`Use.epoch`, `:788,846`) against e's pending only. Undercount = claimed(e).

The deposit side has the mirror race (stale `deposit` vs falling `unclaimed`), but `claim()` handles it by leaving lines the balance can't cover for later (`chain.rs:1390-1400`); the cap side has no such handling (see `one-unpayable-line-never-blocks-the-rest`).

## Discriminating evidence

Competing explanation: "`LEDGER` serializes it." It serializes the file edit, not the chain read: `spent` is a parameter computed outside the lock. Contract side: `_claim` refuses `claimed > cap` (`LeanSettlement.sol:941-942`), so an over-cap line is unpayable, not overpaid; repo test `test_claim_overCap_rejected` (`Settlement.t.sol:347-352`).

## Failure scenario

An agent near its cap makes a call that takes 20 s at the site; the claim loop fires in between. The new line passes the local check and is signed; on chain it can never be claimed. The contributor is told it was paid (`paid_unb` in the reply) and never is; worse, the whole stream can be blocked (sibling property).

## Antithesis angle

A timing race between two loops of one process; Antithesis's thread/scheduling exploration plus a slow site (fixture delay knob) and chain latency make it likely. Advancing the chain clock near an epoch boundary exercises race 2.

## Instrumentation (all missing)

- SUT-side `Always("a passed line never takes the epoch's signed total past the key's cap")` in `push_receipt` after the write: re-read `agentOf` for the line's epoch (use `claimedOf(payer, agent, epoch)`, not `spentThisEpoch`) and compare. Missing.
- Workload `Always("no claim reverts OverCap")`: watch the claim loop's errors (activity log/stdout) and chain `eth_call` simulations. Missing.
- SUT-side `Sometimes("a claim batch mined between a call's cap read and its line")`: a counter of claim batches bumped in `claim()`, read at `push_receipt`; true when it changed since the call's read. Missing; it shows race 1 was explored.

## Open questions

- Is `spentThisEpoch` (current epoch) the intended read, or should it be `claimedOf(..., e)` for the line's epoch? The answer fixes race 2 on its own.
