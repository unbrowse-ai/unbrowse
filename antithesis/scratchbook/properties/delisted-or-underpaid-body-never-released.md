# delisted-or-underpaid-body-never-released

**Focus:** 4 Protocol Contracts, 7. **Confidence:** high that it is the right property. Holds by code reading; the faulty-timing paths are untested.

## Claim being tested

R2.16: "Clients consider only live listings." `peers.rs:117`: "a delisted entry's listing no longer [spreads]". R3.11: "A server releases a body only against a voucher that covers the fee at the price the entry's schedule gives that payer." AGENTS.md: "A listing is checked before an agent sees it."

## Code paths

- Serving: `share::release` (`share.rs:139-168`) reads `entry_by_hash` now, refuses `!e.live`, then `verify_body_voucher(..., e.fee)` (`network.rs:317-329`): `v.amount >= unb(e.fee)` (`:292`), agent authorised, deposit ≥ amount, epoch claimable, nonce unspent. A chain read error is a refusal, never a release.
- Seeking: `listing::verify` (`listing.rs:196-215`) requires the entry live, the same contributor and the same site, at check time. `peers::find_signed` keeps only verified listings (`peers.rs:561`), and `call_entry` re-reads `entry_by_hash` and refuses a delisted one (`api.rs:730-735`).
- Fee: the caller signs `unb(v.fee)` where `v.fee` is the chain fee at its own `verify` (`share.rs:282`), and the server compares with the chain fee at serve time. A raised fee in between is a refusal (see `entry-dark-only-when-providers-served-nothing`). A lowered fee overpays, which is allowed (`>=`).
- Not withdrawn on delist: `delist_route` (`main.rs:613-626`) only resets the `OWN` cache. No `stop_providing` for the site or for the body (the only `stop_providing_body` is `share::drop_cached`, `share.rs:215`). Seeders keep announcing the body, and holders keep serving the held listing (`peers.rs:154-163`, with the fee recorded at hold time, `h.fee`). `hold_tick` never drops held entries that were delisted (`peers.rs:437-514`). Safety then rests entirely on the chain checks above.
- Cache: `do_call` runs a fetched route from `share::cached(entry)` (`api.rs:673`) with no check that the entry is still live.

## Failure scenario in Antithesis

`parallel_driver_owner` delists, relists and reprices (`set_pricing`) node-1's route while `parallel_driver_call` on node-2/node-3 searches and calls it. Faults on the chain link: partitions (a read errors), held packets (a read returns late), node hang on `chain`. The interleaving to hunt is "delist or raise fee lands between the caller's `verify` and the server's `release`", and "a stale RPC answer on the server says live". With one Anvil there's no lagging replica, so the second needs a custom fault or is out of reach.

## Invariant and assertions (all missing)

- SUT-side at `share.rs:167` (just before `Ok(bytes)`): `Always(e.live && v.amount >= unb(e.fee))` on values read in that call. Message: "a body is released only for a live entry and a voucher covering its fee now".
- Workload: for every body release logged by a server (activity "Served a route's body"), `Always(the chain shows the entry live and fee ≤ the voucher amount at a block within the release's window)`. This needs the release log to carry the block number.
- SUT-side at `peers.rs:561`: `Always(v.entry live)` after verify is tautological. Instead use `Reachable("a seeker dropped a listing because its entry is delisted")`, so exploration covers the stale-holder path.
- SUT-side at `api.rs:686` for a route with `fetched`: `AlwaysOrUnreachable(entry live)`. Message: "a cached copy of a delisted entry isn't run". Whether this is a violation depends on the first open question.

`Always` for the release check: a server must never release on terms the chain doesn't support at that moment.

## Why it matters

Delisting is a contributor's (and a site's, R4.17) only way to stop a route. A body released for a delisted entry or below its fee pays out on terms the contributor withdrew. Since the network keeps advertising delisted routes (site records, body records and held listings are never withdrawn), every release depends on the server's chain read being right at that moment.

## Open questions

- May a caller keep running its cached copy of a delisted entry (R2.6 "Caches MAY keep a version indefinitely") or not (R2.16, R3.36 for fraud-ended or site-delisted entries)? This decides whether the cache assertion is a violation.
- Should delisting withdraw the provider records (site and body) and should `hold_tick` drop delisted held entries? Not required for safety, but they keep a dead entry's listing occupying answer room (`listings-answer-fits-its-bound`).
- Is the price a seeker shows the held fee (`h.fee`) anywhere? `peers::find` uses `v.fee` from the chain, so this looks safe; confirm no other path reads `Listing.fee`.
