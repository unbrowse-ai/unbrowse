---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
focus: 11 (wildcard)
confidence: medium
---

# A route's write/read label is decided by a path-keyword heuristic a contributor controls

## What led here

`route.write` — the flag the whole read-only protection (#25, `reads_only`,
`read_only_goal`) hangs on — is computed by `unbrowse_learn::ledger::writes`
(`crates/learn/src/ledger.rs:24-36`):

```
if method is GET/HEAD  -> read
if method != POST      -> write
POST: read iff the last path segment is one of
  query queries search _search msearch _msearch autocomplete suggest
  (or the path contains "graphql" and the body proves a query)
```

For a *fetched* body this is recomputed locally in
`recipe::into_route` → `store::Route::from_graph` → `changes_state(target)`
(`store.rs:285-287`, `recipe.rs:442`), so the contributor's self-declared
`write` in the body is **not** trusted — good. But the recomputation uses the
same keyword heuristic, and the heuristic reads the **contributor's own URL
template**.

## The gap

A contributor who wants their state-changing call classified as a *read* only
has to name its endpoint so the last path segment is `search` (or `query`,
`suggest`, …):

- `POST https://site.example/api/items/search`  → classified **read**
- `POST https://site.example/graphql` with a crafted query-shaped document →
  classified **read** (`proves_a_query`)

The site is free to treat `POST …/search` as a mutation (many "search" endpoints
log, create saved-searches, or the contributor points the template at a path the
site routes to a write). Once classified read, the route passes `reads_only`,
passes the #25 learn-time drop, and — combined with the autonomous-fetch path
(see `network-write-never-auto-run-for-a-read-intent.md`) — is auto-paid and
auto-run against the caller's session for any read goal.

## Why it matters

The read/write boundary is a security boundary (Focus 6) but *which side of it a
call lands on* is decided by a string the adversary writes. No focus owns "the
classifier's own inputs are attacker-controlled." The content id binds the
recipe bytes, so the recipe can't be swapped after the signature — but the
recipe the contributor signs is already the adversarial one.

## Instrumentation (vs existing-assertions.md: none)

- A `Sometimes(a POST classified as read ran a 2xx against a non-idempotent
  site response)` to exercise the heuristic under the workload.
- `AlwaysOrUnreachable`: when a fetched route is run and `ledger::writes` said
  read for a POST, the server's response did not carry a `Set-Cookie`/`Location`
  that the ledger's own `possible_commit` would flag. (Weak proxy; the real
  check needs SUT knowledge of whether the site mutated.) Partially present as
  `ledger::possible_commit`, not asserted.

## Open Questions

- Does any real target route a `POST …/search` to a mutation? Needs a fixture
  site that mutates on a "search"-named path to turn this into a hard repro.
  `(needs human input)`
- Should the write heuristic ever classify a POST as a read without the site's
  own idempotency signal, or only GET/HEAD and proven GraphQL queries?
- `proves_a_query` trusts the request's own operation text; a persisted-query
  hash sends nothing and is treated as a possible write (good) — confirm no
  template-blanking path makes a mutation look like a query.
