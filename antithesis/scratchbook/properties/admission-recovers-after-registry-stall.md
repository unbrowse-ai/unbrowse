# admission-recovers-after-registry-stall

**Focus:** 7 Distributed Coordination (primary), 4 Protocol Contracts. **Confidence:** high (confirmed by probe).

## Claim being tested

R7.26: a peer that is listed and placed enters the routing table, and the result is cached for an epoch. Implied: when the registry can be read, a registered peer is judged. `node.rs:120-122`: a refusal is short "so a peer refused because its identity hadn't yet said where it is should count as soon as it has".

## Code paths

- `node.rs:752-756` `ask_who`: sends hello only while `asking.insert(peer)` succeeds.
- `asking` is cleared only by `judged` (`node.rs:898`) or by a hello `OutboundFailure` (`node.rs:1020-1024`). `ConnectionClosed` (`node.rs:941-946`) does **not** clear it.
- `node.rs:1011-1018`: the hello response spawns `registry.identity(&claim.identity).await` with **no timeout**. The `Judged` message comes only when that future completes.
- `Erc8004Registry::read` (`app/src/erc8004.rs:185-209`): 3 `getMetadata` calls plus a `get_logs`, each over `ProviderBuilder::new().connect_http(...)` (a fresh alloy/reqwest client with no request timeout, sut-analysis Assumptions).
- `Cmd::Admit` (`node.rs:823-834`): with standing `None`, it pushes a waiter and calls `ask_who`, which is a no-op while `asking` holds the peer. `Net::admit` (`node.rs:477-494`) gives up after 10 s (plus a `Locate` and a second 10 s), returning `Unreachable`. The waiter's sender stays in `st.waiting` until a `tell`, so every lookup adds one (unbounded growth per wedged peer).
- Read errors are a separate case: `read` returns `None` on any RPC error (`.ok()?`), `admit()` turns `None` into `Refusal::Unregistered` (`admission.rs:63`), and `judged(Err)` refuses for `refusal_ttl` (600 s), removes the peer from the table and drops its held records (`node.rs:910-916`). A transient chain fault is cached as "unregistered".

## Probe evidence (`antithesis/scratchbook/probes/net-probe.rs`, `probe_registry_hang_wedges_admission`)

A registry whose `identity("0xb")` never returns while a flag is set. B dials A, so A's read for B hangs. Then the flag clears: every later read would answer at once.

- `a.admit(B)` after the recovery took 10.0 s and returned **`Unreachable`**. A second admit also returned `Unreachable`.
- Identity reads made after the recovery: **0**. A never asked again.
- B is not in A's table, while B's view of A is `Counts("0xa")`: the wedge is one-sided.

Discriminating detail: the registry was healthy and B was registered, yet A made no read. Only the stuck `asking` entry explains that.

## Failure scenario in Antithesis

A partition (or packets held) between a node and the chain while peers connect. The read stalls on TCP retransmission. The wedge lasts until that one future completes, which the node does not bound (on Linux, a blackholed established connection takes about 15 min of retransmits; a held-then-delivered fault ends sooner). Meanwhile that peer cannot be judged, its provider records are held then dropped at `ConnectionClosed`, and lookups that name it as a provider time out after 20 s each. A read error (RST, refused) instead turns into a 600 s refusal of a registered peer.

## Invariant and assertions (all missing)

- Workload liveness, after `ANTITHESIS_STOP_FAULTS` and a recovery window W (e.g. `refusal_ttl` + 60 s on a harness with a short `refusal_ttl`): `Always(for every pair of registered, connected peers: a.admit(b) == Counts)`. This is checked once per quiet period. Message: "after the chain recovers every registered peer counts".
- SUT-side at `ask_who` `node.rs:753`: `Sometimes(!asking.insert(peer) && asked_at[peer].elapsed() > 30s)`, "a hello verdict has been pending over 30 s". It is a fault-steering anchor for the wedge.
- SUT-side at `judged` `node.rs:910`: `Reachable("a peer was refused because the registry read failed")`. This needs the instrumented build to tell `None`-from-error apart from `None`-from-absent, so `Registry::identity` must surface the error.
- SUT-side at `Cmd::Admit`: `Always(st.waiting[peer].len() <= 64)`, which catches the waiter leak.

The main check is `Always`, evaluated only after the quiet period: the condition must hold every time it is checked once faults stop. A plain `Sometimes(counts)` would pass if any single re-admission ever happened.

## Why it matters

Admission gates the table, provider records and lookup sources. A short chain fault at the moment two nodes meet can keep one invisible to the other (as a source, a relay or a body provider) for the life of the stuck RPC, and a read error refuses a registered peer as if it were an impostor. Both look like "the network is small" to a seeker.

## Open questions

- Is a registry read failure meant to be cached as a refusal (600 s), or retried? R7.26 only covers peers that fail the check. If refusing is intended, the property's recovery window must include `refusal_ttl`.
- Should `Registry::identity` carry a timeout in the net crate (so that every implementation is bounded), or in `Erc8004Registry`? This changes where the SUT assertion goes.
- In Antithesis, is the hung read ever permanent (chain container replaced, old IP dead with no RST), or always bounded by TCP? That decides whether the liveness check needs a long W.
