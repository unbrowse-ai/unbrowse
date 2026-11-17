---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
focus: 11 (wildcard)
confidence: medium
---

# The owner's per-fetch maximum is compared against the fee in the same unit

## What led here

`max_fetch_usdc` (autofetch `store.rs:449-455`) is documented and named as a sum
of **USDC**: "The most the node pays, in USDC, to fetch one route." The gate
(`api.rs::over_max`, `call_entry`, `network_goal`) compares it directly to
`listed.fee`:

```
fn over_max(fee: f64, max: f64) -> Option<String> {
    (fee > max + 1e-9).then(|| ...)
}
```

`listed.fee` is `listing::Verified.fee`, read from the chain entry
(`listing.rs:verify` → `entry.fee` → `feeOf[contributor]`). But the `Verified`
struct documents that field as **UNB**: "The contributor's detail fee now, in
UNB" (`listing.rs:189`), and the listing `Price.currency` defaults to `"UNB"`
(`listing.rs:41`). The voucher amount is then `chain::unb(v.fee)` — treated as
UNB smallest units.

The SUT analysis wildcard §9 already flags "fees settle in USDC and the bond in
UNB" and "agent caps named `cap_unb` are USDC on chain," and the deploy comment
(`chain.rs:525-527`) says the node counts **everything** in 18 decimals, while a
live Arc USDC is 6 decimals and "needs the node to count it as it is first."

## The property

`over_max(fee, max)` is only a correct money bound if `fee` and `max` are the
same currency *and* the same scale. On devnet both tokens are the test tokens at
18 decimals and at par, so the comparison is numerically fine and tests pass.
On a live network where the fee is denominated/scaled differently from the
owner's USDC intent, `over_max` either lets through fetches far over the owner's
stated dollar ceiling or blocks everything — the owner's one spending guardrail
on the autonomous path becomes meaningless.

This is a cross-cut: it is not a data-integrity bug (the number round-trips
consistently) and not a protocol-contract bug (no message is malformed) — it is
a *units* bug in the one check that protects the owner's wallet when the agent
spends with no approval.

## Instrumentation (vs existing-assertions.md: none)

- `Always`: at the moment a body voucher is signed, the USDC value the owner is
  actually committing (the fee converted to the owner's deposit currency) is
  `<= max_fetch_usdc`. This requires the SUT to expose the fee's true currency
  and scale, which today it does not — the check compares raw f64s.
- `Sometimes(a fetch was skipped by over_max)` to confirm the ceiling ever binds
  under the workload.

## Open Questions

- Is the fee `feeOf[contributor]` denominated in USDC or UNB on chain? `setFee`'s
  comment says "detail fee in USDC" (`LeanSettlement.sol:722-727`), while the
  node's `Verified.fee` and listing `Price` say UNB. Which is authoritative
  decides whether `over_max` is even the right comparison. `(needs human input)`
- On live Arc (6-decimal USDC), does `chain::unb(fee)`/`to_f` mis-scale the fee
  relative to the owner's deposit? `chain.rs:203-210` hardcodes a 12-decimal
  shift. `(partial: devnet uses 18-decimal par tokens, so the bug is invisible
  in every test; live scaling is asserted nowhere)`
