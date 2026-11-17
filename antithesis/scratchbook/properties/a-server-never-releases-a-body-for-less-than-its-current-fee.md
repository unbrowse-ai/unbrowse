---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
focus: 11 (wildcard)
confidence: medium
---

# The fee a caller pays is the one it read; a server releases only at its current fee

## What led here

The fee moves through two independent reads for one fetch:

1. Caller side (`call_entry`): `listed = share::listing_of(...)` reads
   `entry.fee` once. `over_max(listed.fee, …)` and the voucher amount
   (`chain::unb(v.fee)` in `share::fetch`) both use this one value.
2. Server side (`share::release` → `network::verify_body_voucher`): reads the
   entry fresh (`entry_by_hash`) and checks `v.amount >= chain::unb(e.fee)`
   (`network.rs:check_body_voucher`), against the fee **as the server sees it
   now**.

A route seller can move its fee (`setFee`, `LeanSettlement.sol:722-727`) between
the caller's read and the server's serve. The adversarial playbook (the scope
asks for exactly this — "a route seller pricing, delisting, re-listing"):

- **Raise after the caller reads:** the voucher amount (old, lower fee) is now
  `< e.fee`. Every provider refuses (`"the voucher pays … under the fee"`).
  `share::fetch` collects refusals, returns `NoBody`, the caller writes a
  **failed** network line and sets the entry aside on the doubling schedule
  (`share::tried(...false)`, `Dark`). The seller has made its *own* entry go
  dark in that caller and cost the caller a wasted fetch + a failed-line write.
- **Lower after the caller reads:** the server serves (voucher ≥ new lower fee),
  and the caller's paid line amount is `listed.fee` — the *old, higher* figure
  (`chain::add_network_receipt(... listed.fee ...)`). The caller pays more than
  the seller's current published price.

## The invariant worth pinning

The server-side half is the safety property and the regression target: **a body
is released only against a voucher whose amount covers the entry's fee at the
block the server serves** — never a stale lower fee. This is
`verify_body_voucher`'s `v.amount >= chain::unb(e.fee)` check, and it must hold
under a fee that changes concurrently with the serve. The caller-side "pays the
fee it read" is the matching liveness/annoyance side, bounded by `max_fetch`.

## Why it matters

Autonomous fetch means no human watches the price between read and pay. The
server check is the only thing stopping a caller from being served at a price it
never agreed to; a race here is a direct money leak or a griefing vector
(forcing a competitor's callers to blacklist an entry by oscillating fee).

## Instrumentation (vs existing-assertions.md: none)

- `Always` in `verify_body_voucher`: the released body's voucher amount
  `>= chain::unb(e.fee)` where `e` was read in the same serve. Present as a
  plain `return Err` today; not an Antithesis assertion. Antithesis should flip
  the fee concurrently (a second actor calling `setFee`) and confirm no serve
  slips through below the new fee.
- `Sometimes(a serve was refused because the fee moved up mid-fetch)` to prove
  the race window is reached.

## Open Questions

- When the caller pays the stale higher fee (seller lowered), does
  `accept_receipt` on the contributor side accept `l.amount > e.fee`? It checks
  `l.amount >= fee` (at least the fee) — so yes, the overpayment is accepted and
  claimed. Is paying above the current published fee acceptable, or should the
  line be clamped to the current fee? `(needs human input)`
- Delist/relist between read and serve: `release` rechecks `e.live` and
  `verify_body_voucher` rechecks the entry — confirm a relisted entry under a
  *new contributor* can't be served against a voucher signed for the old one
  (entry id is content-addressed by route id, contributor can change on relist
  per `LeanSettlement.sol:711-720`). `(partial: entry_by_hash returns current
  contributor; voucher doesn't name contributor, only entryId + contentId)`
