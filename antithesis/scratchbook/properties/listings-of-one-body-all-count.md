# Listings of one body all count

**Status:** fixed 2026-11-04 (PR #192, `fix(node): every listing of a shared body counts`); found 2026-11-03, a node
defect against the spec.

**Spec:** R2.16: listings only accumulate, and nothing is overwritten. R2.21: an identical copy is the same entry, and
only its first publisher sets its price. R2.22: descriptions are what clients find candidates by. R2.4: an entry is
named by its body's content id.

**Property:** when two live listings name one body, a client keeps both. A goal worded like either one finds the
entry, and the terms of the first publisher's listing are never replaced by a later one.

**Assertion:** `parallel_driver_call.py`, Sometimes: "a write goal finds its route by its own listing's words though
another listing shares the body (R2.16, R2.21)".

**Evidence (local, 2026-11-03, core main d35db2f):**

- node-1 publishes both listings: route-cart, "Add an item to the cart", and route-lookup, "Look up items". They
  have the same content id, `sha256:8b9be256…`, so one entry, `0xe5aab3…`.
- node-3's `known-listings-*.json` holds only the "Look up items" listing.
- With no owner driver running, `/v1/do` for "add an item to the cart" was refused 6 times out of 6:
  `422 browser_missing`. The node never asked the network for the write route. "search items" succeeded 6 times out
  of 6.

**Cause:** `Share::saw` (`unbrowse-node/app/src/share.rs`) keeps one listing per entry, the one with the newest
version. On an equal version the later one wins (`<=`). The listing seen second replaces the first, whatever its
route, description or contributor. `known_on` then shows only that one, and `network_goal` matches goal words against
it alone.

**Risk (inferred, not tested):** a copier who lists someone else's body at the same or a higher version replaces the
original listing's terms in every client that reads the copy later.

**Fix direction:** key the known listings by listing (entry, contributor, route id), not by entry, and match goals
against every live listing of an entry. Credit and price stay with the first publisher (R2.18, R2.21).

**Fix (2026-11-04):** it was three places, not one.

- `kept` in `crates/net/src/node.rs` deduplicated a providers' answer by entry id, so the second listing of a body
  never reached the asker.
- `Share::saw` kept one listing per entry.
- The held-routes answer (`peers.rs`) skipped a second held listing of the same entry.

All three now key by listing: entry, contributor, and the words or route. `listing::remember`, the copy kept across
restarts, is keyed per listing too.

Proof:
- Unit tests `node::tests::listings_that_share_a_body_are_each_kept` (net) and
  `share::tests::listings_that_share_a_body_are_each_known` (node) pass, as do the other net tests (43) and node
  tests (457, plus 5 passkey tests that need Chrome, absent from the test container).
- The harness Sometimes, which was 0 true of 62 hits before, came true 45 of 45 in a 12-minute soak (seed 2026).
