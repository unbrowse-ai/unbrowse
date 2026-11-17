# body-voucher-releases-one-body

**Focus:** 9 Idempotency and Replay, 6 Security Boundaries. **Confidence:** high on the mechanism; low on impact. **Status:** confirmed by code reading (replay after restart, replay across servers).

## Property

A body voucher releases at most one body: once a server has released a body against an (agent, nonce), that voucher buys nothing more from that server, across restarts, nor from another server.

## Claimed guarantee

- `network.rs:201` "Unique per voucher, so a server refuses one it has already released a body for."; `:298-299` "so a voucher pays for one body, not for every ask it is resent with."
- protocol.md R7.5/R3.11 release only on payment.

## Code path

- `network.rs:300-311` `SPENT`: a process-static `Vec`, never persisted. `verify_body_voucher` (`:317-329`) calls `spend()` last.
- The typed data `BodyFetch` (`:173-187`) names payer, agent, entry, content id, amount, epoch, nonce, and **no server**. Any server holding the same body accepts it once.
- Each release adds a `SERVED` note (`network.rs:335-342`, `share.rs:153`), and each note lets one more owed line be kept (`accept_receipt` -> `take_served`, `network.rs:344-354,392`).
- `spend()` runs before the last `await` in `release` (`share.rs:151-153`): if the 10 s `SERVE_TIMEOUT` fires during `current_epoch`, the voucher is spent and no `SERVED` note is written (sut-analysis §5.15).

## Impact, honestly

A body voucher is not money: the fee moves only in the payer's later receipt line. Any authorized agent can mint fresh vouchers at will, so replaying one buys a caller nothing it couldn't sign anyway. The replay matters in two narrower ways: (1) it breaks the stated one-voucher-one-body rule the server's bookkeeping relies on (`SERVED` counts), and (2) a voucher seen by one server is valid at every other server of that body within its two-epoch window.

## Antithesis angle

Restart a server node between two identical asks; the workload needs a raw libp2p client that can resend captured payment bytes (the net crate's test harness, `crates/net/tests/bodies.rs`, already builds one). Kill during `release` to hit the spent-but-not-served window.

## Instrumentation (all missing)

- Workload `Always("a replayed body voucher is refused")`: send the same voucher bytes twice to one server, with a restart in between; the second must be `Refused`. Expected to fail across restart. Missing.
- SUT-side `AlwaysOrUnreachable("a released voucher was never released before by this identity")` in `release`, backed by a test-only persisted set. Missing.
- SUT-side `Sometimes("a voucher is spent but the serve timed out before SERVED was noted")`. Missing.

## Open questions

- Should the voucher name the server (peer id or wallet) so it can't be spent at another server? That changes the typed data and so every signature; it is a protocol decision.
- Is a persisted `SPENT` worth it given vouchers carry no value, or should the docs drop the "pays for one body" claim? The answer decides whether this stays a property.
