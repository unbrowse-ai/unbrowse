# too-old-peer-never-counts

**Focus:** 10 Version Compatibility (primary), 4 Protocol Contracts. **Confidence:** high (one path confirmed by probe; the in-flight race path not reproduced on loopback).

## Claim being tested

`app/src/update.rs:9-10`: "A node older than the network's `min_version` stays off the peer network, and its peers refuse it." The node-side comment at `crates/net/src/node.rs:953-954`: "A peer older than the network takes is refused ... none stays behind on it." `Config::min_peer_version` doc (`node.rs:127-128`): "an older peer, or one that doesn't say, is refused."

## Code paths

- `node.rs:952-961` (Identify `Received`, `too_old` branch): inserts `refused`, removes `routable`, `kad.remove_peer`, `tell(Refused)`, `disconnect_peer_id`. It **never touches `admitted` or `asking`**.
- `node.rs:680-690` `State::standing`: checks `admitted` first (TTL `admission_ttl`, 24 h by default), and only then `refused`. A peer in both maps is `Counts`.
- `node.rs:897-909` `judged(Ok)`: unconditionally inserts `admitted` and removes `refused`. It does not re-check the version.
- `node.rs:935-939` `ConnectionEstablished`: a peer whose standing is already `Counts` is not asked again, so a reconnect at a new version is judged only by the `too_old` branch, which leaves `admitted` in place.
- `node.rs:1011-1018`: the hello verdict is computed in a spawned task (registry read), so a `Judged(Ok)` can land after the Identify refusal.
- `too_old` (`node.rs:759-762`) is unit-tested; nothing tests the interaction with admission.
- Reached only when `min_peer_version` is set: `peers.rs:342` from `update::network_minimum()` (`update.rs:155-157`), i.e. `UNBROWSE_RELEASE` builds with a kept manifest. In a net-only harness it is a plain `Config` field.

## Two ways a too-old peer ends up counting

1. **Admitted, then seen too old (confirmed).** A peer admitted at an acceptable release later shows an older agent version on a new connection (rollback of `versions/current`, a second install under the same key, or an older binary restarted with the same `peer-key.json`). `ConnectionEstablished` skips the ask (standing is `Counts`), Identify fires the `too_old` branch, `refused` is inserted, `admitted` stays: `standing()` returns `Counts` for the rest of `admission_ttl`.
2. **Hello verdict in flight (suspected).** On first contact both the hello response and Identify arrive about 1 RTT after the connection opens. If the hello response arrives first, the registry read is spawned; Identify then refuses and disconnects; the late `Judged(Ok)` re-admits the peer and clears `refused`.

## Probe evidence (scratch copy of the net crate, loopback, not in the repo)

Source: `antithesis/scratchbook/probes/net-probe.rs`, log: `antithesis/scratchbook/probes/net-probe.log`.

- `probe_admitted_peer_seen_too_old_still_counts`: node A has `version = min_peer_version = 2.0.0`. Peer B (key K, `2.0.0`) is admitted: `Counts("0xb")`. A second swarm with the same key K and `version = 1.0.0` dials A. After Identify, `a.admit(B)` is still **`Counts("0xb")`**. Discriminating: the only code that ran on the second connection was the `too_old` branch (standing was `Counts`, so no hello was sent), and it left the admission.
- `probe_version_gate`: 20 fresh pairs, too-old B dials A on first contact. **20/20 `Refused`**. On loopback Identify consistently arrives before the hello response, so path 2 was not reproduced. It needs latency, reordering on QUIC streams, or thread pausing, which is what Antithesis supplies.

## Failure scenario in Antithesis

Net-only harness (deployment-topology.md, "Not included"): N `Net`s, one with `min_peer_version`, one peer whose `Config.version` is below it. A custom fault restarts a peer with an older `version` under the same key (rollback). Network congestion and CPU modulation vary the order of hello and Identify on first contact.

## Invariant and assertions (all missing: `existing-assertions.md` shows no SDK in the repo)

- SUT-side, `standing()` in `node.rs:680`: `Always(!(returns Counts && st.seen_too_old.contains(peer)))`, where the instrumented node records the last agent version Identify reported per peer. Message: "a peer Identify reported below min_peer_version never counts".
- SUT-side, `judged(Ok)` `node.rs:900`: `AlwaysOrUnreachable(!too_old(last_agent_version[peer]))`. Message: "an admission never lands for a peer already seen too old". It is unreachable when no too-old peer exists.
- SUT-side, `node.rs:955`: `Reachable("a too-old peer was refused by Identify")` and `Sometimes(asking.contains(peer))` at the same line ("Identify refused a peer whose hello verdict was still in flight"). This is the race anchor that steers exploration toward path 2.
- Workload: after each round, for every pair (new node, old peer), `Always(new.admit(old) != Counts)`, and `Always(found.sources excludes old peer's identity)` on lookups.

`Always` fits: the guarantee is "never", and it must hold on every evaluation, under every fault.

## Why it matters

The version gate is the network's only way to retire a release that newer nodes can't mix with (`update.rs:9-10`). A too-old peer that counts enters lookups as a source (`node.rs:374-387`), can make a lookup `checked`, has its provider records kept, and can be picked as a relay (`node.rs:737`).

## Open questions

- Should a version seen too old after admission evict the peer (clear `admitted`), or is "admitted for an epoch" (R7.26 caches the result for an epoch) meant to win? The update.rs comment says refused; R7.26 says nothing about version. If the cache is meant to win, the property narrows to first contact (path 2) only.
- Is a rollback with the same peer key reachable in production? `update.rs` never lowers `current` below the running version, but an owner can reinstall an older package. That decides whether path 1 is a production bug or only a harness one.
- Does path 2 occur over QUIC (independent streams) more often than over TCP/yamux? Not measured.
