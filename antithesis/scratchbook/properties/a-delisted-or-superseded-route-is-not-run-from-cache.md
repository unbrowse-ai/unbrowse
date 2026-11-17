---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
focus: 11 (wildcard)
confidence: medium
---

# A cached fetched route keeps running after its entry is delisted or superseded

## What led here

A fetched route becomes a local `Route` with `fetched = Some(..)`
(`recipe::into_route`), and is reused with **no new payment while it works**
(R3.12). The reuse path (`api.rs::do_call`):

```
let route = store::load_route(&id).or_else(|| is_network_entry(&id).then(|| share::cached(&id)).flatten());
...
Some(route) => run_route(node, a, route, inputs, None).await,   // paying = None
```

`run_route` with `route.fetched.is_some()` sets `entry = None` (no billing) and
then calls `bound` + `call_watched`. It does **not** call `entry_by_hash`,
`listing::verify`, or any `e.live` check. The only thing that retires a cached
fetched route is a *failed run* (`run_route`: `if route.fetched.is_some() && !r.ok { drop_cached }`).

Compare the fresh-fetch path (`call_entry`), which checks `ev.live`, re-verifies
the signed listing against the chain, and checks the dark/off-ranking schedule
before every network call. None of that runs on a cache hit.

## The property

Once a caller has fetched a route once, it keeps executing that body on cache
hits even after the contributor **delists** the entry (`delistEntry`,
`LeanSettlement.sol:731-739`) or **supersedes** it with a new version. R2.6 does
say a version never changes and caches may keep a version indefinitely — so
reusing the old *bytes* is intended. The wildcard concern is **delisting**: a
contributor delists an entry precisely to withdraw it (it was wrong, harmful, or
abused). A caller's node ignores that signal entirely for cached copies and goes
on running the withdrawn route — and for a cached *write* route, it goes on
mutating the site through a recipe the author has retracted, with nothing to
re-check and nothing to pay (so no failed line even signals it).

## Why it matters

Delisting is the contributor's and the network's only kill switch for a bad
route. If the kill switch doesn't reach the nodes that already cached the body,
a harmful or broken shared route lives on in every caller that ran it once.
Crosses failure-recovery (Focus 3), protocol contracts (Focus 4) and the
economics, owned by none: the cache correctness question is "when does a cached
copy stop being honored?"

## Instrumentation (vs existing-assertions.md: none)

- `AlwaysOrUnreachable`: when a cached fetched route runs (`paying == None`,
  `route.fetched.is_some()`), its entry is still `live` on chain as of some
  bounded staleness. Missing; no chain read happens on the cache path at all.
- `Sometimes(a cached fetched route ran after its entry was delisted)` — if the
  workload delists an entry a peer has cached and the peer still serves it, the
  property has fired.

## Open Questions

- Is honoring a cached version after delist intended (R2.6 "caches MAY keep a
  version indefinitely"), or should delist invalidate caller caches? The spec
  text covers *version immutability*, not *withdrawal*. `(needs human input)`
- Should a cached *write* route be treated differently from a read on delist?
  A withdrawn write route re-running against the user's account is the sharp
  edge.
- The ignored test `a_node_finds_another_nodes_route_by_naming_its_site`
  (`peers.rs:664-774`) asserts delist invalidates the *listing* a fresh seeker
  reads, but not that a previously-cached route stops running. `(partial:
  delist-invalidates-listing is tested; delist-invalidates-cache is not)`
