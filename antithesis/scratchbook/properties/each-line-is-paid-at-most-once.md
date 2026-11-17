# each-line-is-paid-at-most-once

**Focus:** 9 Idempotency and Replay, 1 Data Integrity. **Confidence:** high that the contract enforces it; medium that the node's file handling keeps leaves stable. **Status:** expected to hold; regression guard plus two mechanisms to watch.

## Property

However often a node restarts, retries a claim pass, or re-signs a running voucher, each receipt line is paid at most once, and per (payer, agent, epoch) the total paid never exceeds the largest cumulative the agent signed nor the key's cap; payees together never receive more than the deposit (R3.23).

## Claimed guarantee

- protocol.md R3.23 "The contract pays a claimable line once ... Whatever order claims arrive in and however often one is repeated, the total paid never exceeds what was signed for ...; payees together never receive more than the deposit."
- `chain.rs:1133-1136` holders "Fixed the first time a voucher covers the line, so every later voucher hashes it the same way and it can't be claimed once under each."
- `chain.rs:1147-1153` "A claim never submits the same lines twice."

## Code path

- Contract: `spentLine[keccak(payer, agent, epoch, leaf)]` (`LeanSettlement.sol:934-936`), `_claimed <= v.cumulative` and `<= cap` (`:938-943`), `amount <= balance` (`:948`). The leaf covers `(index, entryId, amount, passed, holders)` (`:869-879`).
- Node: `claim()` re-checks `spentLine` before sending and marks spent lines claimed (`chain.rs:1393-1396,1413-1415`), so a crash after a mined batch and before `mark` recovers on the next pass. `claim_owed` drops spent lines (`:1542-1544`).
- Leaf stability depends on the receipts file: `index = all.len()` (`chain.rs:1236`) and holders written once (`:1354-1366`). `receipts()` uses `store::read_json` (`chain.rs:1143-1145`), which turns a parse error into an empty list (`store.rs:59-61`), and the next `push_receipt` writes that empty list plus one line back (`:1160-1166`). Writes are tmp+rename without fsync (`crates/learn/src/client.rs:561-573`).

## Mechanisms that could break it (to explore, not established)

- A receipts file that reads as empty or older (lost rename after a host crash, or a torn file) restarts indexes at 0 and may re-derive holders differently (`running_voucher` reads `holding()` again, `chain.rs:1348-1351`). A line already sent to a contributor under its old leaf and the same line under a new leaf are different `spentLine` keys. The contract's cumulative check still bounds the total, so the expected harm is a later legitimate line refused `OverCumulative`, not overpayment; the invariant catches either.
- A second process writing receipts (the CLI and the node) shares no `LEDGER`; whether any CLI path writes receipts was not checked.

## Antithesis angle

Kill the payer node during and right after `claimBatch` (between mine and `mark`), restart, and let it retry; kill the contributor during `claim_owed`. Partition from the chain after `send()` so `get_receipt()` hangs. These are the classic at-least-once retry shapes.

## Instrumentation (all missing)

- Workload `Always("no receipt line is paid twice")`: decode every `claim`/`claimBatch` transaction's calldata; no (payer, agent, epoch, index) appears in two successful claims. Missing.
- Workload `Always("a stream's claimed total stays within its cap and signed cumulative")`: `claimedOf(payer, agent, e) <= termsFor(payer, agent, e).cap` and `<=` max cumulative seen in any submitted voucher for e. Missing.
- Workload `Always("claims never draw a payer below zero")` is implied by the contract's checked arithmetic; instead `Always("sum of Claimed amounts per payer <= its deposits")`. Missing.
- SUT-side `Sometimes("a claim pass finds lines already spent on chain")` at `chain.rs:1395-1396` (the recovery branch). Missing.

## Open questions

- Does any process other than the running node append to `receipts/` (CLI commands, a second node on the same home)? If yes, the in-process `LEDGER` doesn't serialize it and indexes can collide.
- Should `receipts()` read strictly (`read_json_strict`) like `agents.json` and the listing book? A file that doesn't parse would then stop the node instead of being overwritten.
