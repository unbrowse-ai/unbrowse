# a-kept-body-was-paid-for

**Focus:** 6 Security Boundaries (fee bypass), 1 Data Integrity, 9 Idempotency (crash between steps). **Confidence:** high for the two code paths, medium for the crash window. **Status:** confirmed by code reading.

## Property

A caller keeps another contributor's body (a route with `fetched` set) only when a line for that use exists in its receipts: a passed line naming the entry, or a failed line after which the body was dropped. A body that was served and never billed is never reused for free.

## Claimed guarantee

- protocol.md R3.12 "The client caches fetched details and reuses them ... with no new detail payment while that version works. A detail fee is paid **only on a cache miss**." (So the cache miss must pay.)
- R3.11/R7.5 a server releases a body only on payment. The payment is the later line: `network.rs:189-191` "The fee itself moves later, as the receipt line of the use."

## Code path

- `share::fetch` saves the body and the route *before* any line exists: `share.rs:308-310` (`recipe::save_body`, `store::save_route`), then seeds it (`:319`).
- Goal calls reuse it too: `api.rs:374` picks routes with `routes_for`, which matches a fetched route by its `listed_as` (`:526`), and runs it (`:388` records its entry as tried). A write route kept by path 1 is filtered from read goals by `reads_only` (`:374`) but is used by a write goal.
- Reuse is free: `api.rs:673` `store::load_route(&id).or_else(|| ... share::cached(&id))`, then `:686` `run_route(node, a, route, inputs, None)` (no `Use`, no line). `run_route` bills only own entries (`api.rs:803-806` skips `fetched` routes).
- Path 1, reads-only goal: `api.rs:782-786` returns 409 when the fetched route writes and the goal only reads, "the body stays here", **no line at all** (not even a failed one), no `drop_cached`.
- Path 2, cap refusal after the run: `api.rs:846` `add_network_receipt(...)?` refuses (see `cap-is-checked-before-the-site-is-called`); the route stays cached; only a *failed* run calls `drop_cached` (`:854-856`), and that code is after the `?`.
- Path 3, crash: a kill between `store::save_route` (`share.rs:310`) and `push_receipt`'s write (`chain.rs:1164`) spans the whole site call (`api.rs:826`, spawn_blocking HTTP). On restart the route is cached and no line exists. The server's `SERVED` note is memory-only too (`network.rs:335`).

## Failure scenario

Agent asks a read goal; the cheapest entry's route writes; 409, body kept. The same agent (or another agent on that node) then `do_call`s the entry id: the cached route runs, nothing is billed, ever. Same after a 402 cap refusal, or after a crash mid-call. The server released the body against a voucher and is never paid; the contributor never earns.

## Antithesis angle

Path 3 is the Antithesis-shaped one: kill the caller container during a network call (the fixture site can be told to delay, so the window is seconds). After restart, the workload repeats the call and checks for a billed line. Paths 1 and 2 are reachable with ordinary workload choices (a write route, calls near the cap).

## Instrumentation (all missing)

- Workload `Always("every fetched route a caller runs has a line for its entry")`: after each call, read the caller's activity (`kind: network`) and receipts through the owner API; a `do_call` answered from a fetched route with no prior line for that entry from that node is a violation. Missing.
- SUT-side `Unreachable("a fetched body is kept with no line written for its use")` at `api.rs:785` (the 409 return) and at the `?` of `:846`. Missing.
- SUT-side `Sometimes("a caller restarts holding a fetched route with no line")` at startup (scan `routes/` for `fetched` routes, compare with receipts). Missing; it marks the crash window as explored.

## Open questions

- Is the reads-only 409 path meant to bill (the body was served) or to drop the body? Either fixes the property; which one changes the invariant from "a line exists" to "no body is kept".
