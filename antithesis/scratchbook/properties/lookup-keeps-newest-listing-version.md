# lookup-keeps-newest-listing-version

**Focus:** 10 Version Compatibility. **Confidence:** medium (the mechanism is certain from code; whether an older version should lose is a spec question).

## Claim being tested

R2.6: "A contributor's new version of its own entry records the version it supersedes." R2.14: a listing carries "the version, the version it supersedes if any". `listing.rs:241-247` `Book::current`: a node serves "the newest version of each route". `share.rs:38-44` `Share::saw` keeps "the newest version of each entry".

## Code paths

- `node.rs:535-543` `kept`: deduplicates a lookup's listings by `entry_id` **first come, first kept** (`seen.insert`). The net crate never reads `signed` (it is opaque JSON), so it cannot compare versions.
- `node.rs:379-386`: answers are processed in `by_identity` order, which comes from `counted()`'s `buffer_unordered` (`node.rs:393-409`), i.e. the order admissions complete. So which source's version wins depends on timing.
- Who serves an older version: a holder answers with `self.0.share.known(id)` (`peers.rs:159`), the last version it checked. `hold_tick` refreshes that only when it next runs `find` (every 60 s, and only for sites it touches), and with the same first-come dedup. A contributor's own node serves `Book::current` (newest).
- `listing::verify` (`listing.rs:196-215`) accepts any version whose root is posted and whose entry is live: an older, superseded listing stays valid.
- `call_entry` → `listing_of` → `share.known(entry)` (`share.rs:221-226`), so a caller that only ever saw the old version fetches the old `content_id`. The contributor's node still serves old versions (`share.rs:119-124`), so the call goes through and runs the superseded recipe.

## Failure scenario in Antithesis

node-1 lists the route (v1); node-2 holds it (`hold_routes` on) and re-serves v1. node-1 lists a changed body (v2). node-3 looks up the site: answers from node-1 (v2) and node-2 (v1) race; latency and CPU modulation decide which arrives first. With node-1 partitioned during the lookup, only v1 arrives. node-3 then runs v1 for as long as it works (R3.12). This is reachable with the existing roles; it needs the owner driver to "relist with a changed body".

## Invariant and assertions (all missing)

- SUT-side in `peers::find_signed` after verification (`peers.rs:561-565`): for each entry, `Always(v.proven.listing.version >= max version among the verified answers for that entry in this lookup)`. Message: "a lookup keeps the newest version it heard of each entry". This needs the app to see every version (today the net crate drops the others before the app sees them), so the assertion would sit on the raw answers if instrumented in `node.rs`.
- Workload: after node-1 relists, eventually (after a quiet period) `Always(node-3's chosen listing for the entry has version == node-1's latest)`.
- SUT-side `Sometimes(two versions of one entry arrived in one lookup)` as an exploration anchor.

## Why it matters

A contributor fixes a broken route by publishing a new version. A seeker that keeps the superseded one runs the broken recipe, and a failure there darkens the entry (`entry-dark-only-when-providers-served-nothing`), which hurts the fixed version too since the entry id is the same. Mixed versions are what a network in the middle of a re-listing looks like.

## Open questions

- Is a superseded version still a valid body to choose for new fetches (R2.6's "caches MAY keep a version"), or should seekers prefer the newest (R2.18's ordering is "not built yet", `listing.rs:173`)? If superseded versions are deliberately equal, this property is invalid.
- Should the net crate compare versions (that would need a version field on `Listing`), or should it pass every version through and let the app choose? This decides where the assertion lives.
