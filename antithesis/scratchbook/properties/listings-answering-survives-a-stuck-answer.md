# listings-answering-survives-a-stuck-answer

**Focus:** 7 Distributed Coordination, 4 Protocol Contracts. **Confidence:** high (slot exhaustion confirmed by probe; the lock part is from code reading).

## Claim being tested

`peers.rs:98-100`: "Any connected peer may ask, admitted or not, so asking reads this: the chain is read at most once a while, however many ask, one reading at a time." `node.rs:1028`: "Past the bound the request is dropped: the asker hears nothing and may ask again." R7.21: a seeker fetches a site's listings from at least 2 distinct identities. R7.26/R7.18: queries from failing peers, and provider queries, are rate-limited per peer.

## Code paths

- `node.rs:1026-1038`: an inbound listings request is dropped when `st.answering >= MAX_ANSWERING` (16, node-wide, from every peer together). Otherwise `answering += 1` and `listings.site()` is spawned **with no timeout**. `answering` is decremented only when `Inner::Answer` arrives (`node.rs:789-791`). Compare the body path, which wraps its store in `SERVE_TIMEOUT` (10 s, `node.rs:1068`).
- `peers.rs:141-149` `ServedListings::site`: takes the process-wide `OWN` tokio mutex and, when the 60 s cache is stale, holds it across `self.read()`, which is `chain::listed_entries` (`chain.rs:1693-1717`: a full `EntryListed` log scan from the deployment block, then one `entry()` call per entry ever listed by anyone) with no timeout. Every other request, for every site, waits on the lock.
- `peers.rs:146`: when the read fails, the stale cache is kept and served (good), but only once the failing read returns.
- `peers.rs:410-412` `listings_changed` also takes `OWN`, so the owner's list and delist commands block behind a stuck read (`main.rs:623`).
- No per-peer limit on listings asks; `PerPeer` exists only for bodies (`node.rs:1054`).

## Probe evidence (`probe_listings_slots_exhausted`)

Provider A answers `example.com` at once and never answers `slow.example` (standing in for a hung chain read). Seeker s1 makes 20 concurrent lookups of `slow.example`. A control provider E (never stalled) then also provides `example.com`.

- Before the stall: s2 found 1 listing from `["0xa"]`.
- After the stall, 3 tries: s2 found 1 listing from **`["0xe"]` only**, each in about 4 ms. A never answered `example.com` again, though its answer for that site is instant.

Discriminating detail: the same seeker reached the healthy control provider, so the seeker, the table and the site key all worked. Only A's node-wide slot count explains A's silence for a different site.

## Failure scenario in Antithesis

A node→chain partition, latency or node hang on `chain` when a node's `OWN` cache is older than 60 s. The first listings ask takes the lock and blocks in the log scan; up to 15 more asks pile up behind it and every further ask is dropped. The node is silent as a listings source, for every site and every seeker, until the scan returns. Seekers lose a source, so lookups fall below 2 identities (`checked == false`), and a holder re-serving others' listings drops out too. Any connected peer, admitted or not, can trigger the cold read and occupy the slots.

## Invariant and assertions (all missing)

- SUT-side at `node.rs:1029`: `Unreachable("a listings ask was dropped because 16 answers were already in flight")` under normal operation would be too strict under load. Use `Always(st.answering < MAX_ANSWERING || oldest_answer_age < 15s)`: "the listings slots are never all held by answers older than the asker's timeout".
- SUT-side in `ServedListings::site`: `Always(lock_wait < 10s || own cache is cold)`: "a warm-cache listings answer never waits on a chain read". This catches the `OWN` lock held across the scan.
- Workload liveness after `ANTITHESIS_STOP_FAULTS` + 60 s: `Always(seeker.find(site).sources ⊇ {identities providing site})`.
- SUT-side `Sometimes(answering == MAX_ANSWERING)` as an exploration anchor.

Why these types: the stall is a "never for longer than X" guarantee, so `Always` with a time bound. Recovery is checked as `Always` after a quiet period.

## Why it matters

Listings are how every route is discovered (R7.21). One slow chain read on one node silences it as a source network-wide. With a small network (3 nodes) that alone can make every lookup unchecked, and a hostile connected peer can do it at will by asking for sites while the cache is cold.

## Open questions

- Should a stale cache be served while a refresh runs (read outside the lock), as the comment's "at most once a while" suggests? If yes, the SUT assertion on lock wait is the right check. If no, only the timeout and slot release are in scope.
- Is the per-peer rate limit of R7.26/R7.18 meant to cover the listings protocol and Kademlia `GET_PROVIDERS`? No such limit exists in `crates/net`. The answer decides whether a single-peer flood is a property violation or out of scope.
- Does a dropped `ResponseChannel` reach the asker as a fast failure (the probe saw about 4 ms) on every transport? The comment says "hears nothing".
