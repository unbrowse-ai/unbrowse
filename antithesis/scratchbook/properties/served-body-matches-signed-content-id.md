# served-body-matches-signed-content-id

**Focus:** 4 Protocol Contracts. **Confidence:** high that it is the right property. No defect found; it holds by code reading and in the existing five-node test.

## Claim being tested

R3.9: "The client reads an entry's content identifier from the contributor-signed listing ... never from the node that serves the body ... checks its hash, and discards a body that does not match." R7.19: "A body that does not match is a failed try of that provider, is never paid, and is never used." R7.20: such a provider is set aside on the doubling schedule.

## Code paths

- `share.rs:257`: `content_id` is `v.proven.listing.content_id`, from the signed listing that `listing::verify` checked (signature against the identity owner, leaf under a posted root, entry live, `listing.rs:196-215`).
- `share.rs:283-306`: `fetch_body` returns raw bytes; `recipe::verify_body` (`recipe.rs:388-399`) requires `sha256(bytes) == content_id`, a canonical form byte-for-byte, and `check(&recipe)`. A mismatch calls `providers().failed(...)` and moves to the next provider. No line is written for it.
- `share.rs:307-310`: only after verification: `served`, `into_route` (which also requires the body's site to equal the listing's, `recipe.rs:445-447`), `save_body` (re-hashes, `recipe.rs:470-480`), `save_route`.
- `recipe::load_body` (`recipe.rs:482-486`) re-checks the hash on every load, so the serving side never sends a corrupted file as that content id.
- Transport bounds: `body.rs` caps a body at 64 KiB and cuts off a provider that sends more (`a_provider_that_sends_more_than_a_body_may_hold_is_cut_off`). A truncated body fails the hash.
- Existing coverage: `share.rs:766-805` (ignored five-node test) shows a tampered body is refused, set aside, written as a failed line, and takes the entry off the ranking. Plain `assert!`s; no Antithesis assertions.

## What Antithesis adds

Mid-stream faults (connection reset, held then released packets, congestion) on the body stream; a provider killed mid-serve; CPU throttling past `SERVE_TIMEOUT`/`BODY_TIMEOUT`; a tampered provider in the net-only harness (`share.rs:605-612` shows the hook shape). The safety condition must hold under all of them. Also the cache path: a route run from `routes/<id>.json` (`share::cached`) must stem from a body that was verified. A node termination between `save_body` and `save_route` (two separate `write_private` renames, no fsync) must not leave a route whose `fetched.content_id` names a body that isn't on disk or doesn't hash to it.

## Invariant and assertions (all missing)

- SUT-side at `share.rs:307` (after `verify_body`): `Always(recipe::content_id(&body) == l.content_id)`. Message: "a body is used only when it hashes to its signed content id".
- SUT-side at `api.rs` `run_route` for a route with `fetched`: `Always(recipe::load_body(&fetched.content_id).is_some())`. Message: "a fetched route runs only with its verified body on disk". This covers the crash window between the two writes.
- SUT-side at `share.rs:302`: `Sometimes(true)` is a smell here, so use `Reachable("a provider served a body that isn't the listed one")`. This confirms the tampered-provider path is explored in the harness.
- Workload: the fixture site's `/_seen` log (deployment-topology.md) must never show a request that only a tampered body would make. Checked with `Always`.

## Why it matters

This is the property that lets the network carry routes with no trust in who serves them (R7.3, R7.19). If it fails, a seeder can make any caller send its session to any host the tampered recipe names, which is the attack `share::bound` also guards against.

## Open questions

- Is the window between `save_body` and `save_route` (`share.rs:309-310`) reachable with a crash, and does a later call then run a route whose body is missing? `cached()` loads the route only, and `run_route` may not re-read the body. That decides whether the second SUT assertion is needed.
