# entry-dark-only-when-providers-served-nothing

**Focus:** 4 Protocol Contracts (primary), 7. **Confidence:** medium (code path is unconditional; whether all-refused should count is a spec question).

## Claim being tested

R7.20: "An entry is dark (R7.11) only when none of its providers serves it." R7.11: "An entry is dark for an epoch in which it was tried and served nothing." R7.12: on its k-th dark epoch an entry is off the ranking for `min(2^(k-1), 32)` epochs. `share.rs:287`: a provider that refused "isn't set aside for answering".

## Code paths

- `api.rs:757-759`: **any** `Err(share::NoBody(_))` from `share::fetch` calls `share::tried(node, entry, epoch, false)` (marks the entry dark, `share.rs:62-64`) and writes a failed receipt line (`chain::add_network_receipt(..., false, ...)`).
- `share::fetch` returns `NoBody` for causes that are not "the providers served nothing":
  - the caller's own chain or config errors **before any provider is asked**: `chain.deployed()` (`share.rs:260`), `owner_address` (`:261`), `current_epoch` RPC (`:262`), `sign_body_voucher` (`:282`);
  - `asked.is_empty()` (`:276-278`): the registry read for the contributor's nodes failed (`r.identity(...)` → `None` on any RPC error, `:265`) and `find_body_providers` found none (a partition);
  - every provider **refused** (`:286-289`): a provider's own chain fault (`release` reads `entry_by_hash`, `verify_body_voucher` reads `check_agent`, `spendable`, `current_epoch`), "too many asks", the owner's pause, or a voucher under a fee raised since the caller's `listing::verify`;
  - local failures **after a matching body arrived**: `into_route` (`:308`), `save_body` (`:309`) or `save_route` (`:310`) erroring. A provider did serve the listed body.
- Then `call_entry` refuses the entry for the rest of the epoch and the next (`api.rs:738-740`, `Dark::off_until`), and later dark epochs double it.

## Failure scenario in Antithesis

A node→chain partition on the caller during `share::fetch`, or on the provider while it checks the voucher. A CPU-throttled provider hitting `MAX_ANSWERING` would do it too, and so would the owner-driver toggling `paused` on the only provider, or `set_pricing` raising the fee between the caller's verify and the provider's check. Each puts a healthy entry off that caller's ranking for at least the rest of the epoch plus one, and writes a failed line. The workload's epoch-advance fault (`evm_increaseTime`) makes the doubling schedule observable.

## Invariant and assertions (all missing)

- SUT-side at `api.rs:758` (`tried(..., false)`): `Always(fetch asked >= 1 provider && no asked provider returned a body that hashed to the content id)`. Message: "an entry is marked dark only when its providers were asked and served nothing". Instrumenting needs `NoBody` to carry the counts (asked, refused, unanswered, mismatched).
- A stricter variant, kept as its own message if the owner decides refusals don't count: `Always(at least one provider was unanswered or mismatched)`, "an entry every provider refused is not marked dark".
- SUT-side `Reachable("an entry was marked dark after every provider refused")` as an exploration anchor.

`Always` because the spec states a condition that must hold every time an entry is marked dark.

## Why it matters

The dark schedule is the network's only response to silence (R7.13, R7.16), and it costs the entry its picks and fees for a day or more per mark. When it fires on the caller's own RPC fault or on a refusal, healthy entries drop off the ranking, and failed lines are written against uses that never reached a provider.

## Open questions

- Does a refusal count as "served nothing" for R7.11? The code's own comment says a refusing provider isn't set aside, yet the entry still goes dark when every provider refuses. The answer decides between the two `Always` variants.
- Should a caller-local error (its own RPC or disk) produce a failed line at all? That is the money side of the same path, for the receipts agents.
- With one provider (the contributor) in a 3-node network, any single refusal darkens the entry. Is a single-provider entry expected to be this fragile?
