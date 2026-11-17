# table-role-follows-reachability

**Focus:** 7 Distributed Coordination (NAT, R7.23). **Confidence:** medium (holds by code reading; the relay path is unexercised by any test, and no defect found).

## Claim being tested

R7.23: "A node in light mode, or one that cannot be reached from outside, runs the table in client mode: it queries, stores no records and answers no queries. Nodes behind home routers are reached through circuit relays and hole punching." `node.rs:10-13`: a reachable node serves the table and relays; one that isn't asks only and holds a reservation on a relay.

## Code paths

- `serve_as` (`node.rs:706-717`): kad `Mode::Server` iff `Serve::Server`, or `Serve::Auto && reachable()` (`announce_listen || !announce.is_empty() || nat == Public`). The relay is enabled iff `nat == Public && serve != Client`. It is called at start and on every AutoNAT `StatusChanged` (`node.rs:983-1003`).
- Light mode → `Serve::Client` at start only (`peers.rs:325-327`). Toggling `light` takes effect at the next start (documented, `main.rs:790-791`). `share::held` reads the setting live, so bodies stop being served at once while the provider records stay.
- `relay_through` (`node.rs:727-750`): when `nat == Private` and not otherwise reachable, it listens on `/p2p/<relay>/p2p-circuit` for up to 2 admitted, connected relays that have a dialable direct address in `routable`. It drops reservations when no longer needed.
- Stale external addresses are removed when AutoNAT leaves Public (`node.rs:991-1000`). Identify re-advertises protocols, so peers drop a node from `routable` and their table when it stops serving kad (`node.rs:972-979`).
- `autonat_config` (`node.rs:204-217`): `only_global_ips: false`, so RFC1918 container IPs are probed; `throttle_server_period` is 6 probes (90 s).

## Failure scenario in Antithesis

Bad-node faults on node-3, inbound only, make AutoNAT dial-backs fail. node-3 should go `Private`, switch kad to Client, stop relaying, take a relay reservation on node-1 or node-2, and still be found as a provider of its bodies and fetched from (through the circuit, then DCUtR). When the fault lifts it should return to Server. Flapping (repeated asymmetric faults) explores the transitions: a reservation leaking, a Public node holding a reservation, or a Private node left in kad Server mode.

## Invariant and assertions (all missing)

- SUT-side at the end of `serve_as`: `Always(kad_mode == Server ⇒ serve != Client && (serve == Server || reachable()))` and `Always(relay enabled ⇒ nat == Public && serve != Client)`. Message: "the table role and the relay follow reachability".
- SUT-side at the end of `relay_through`: `Always(!needs_relay(st) ⇒ st.relays.is_empty())`, plus `Always(st.relays.len() <= MAX_RELAYS)`.
- SUT-side `Sometimes(nat == Private && !st.relays.is_empty())`: "an unreachable node holds a relay reservation". It is a liveness anchor that shows the relay path was exercised.
- Workload, after faults on node-3 and a quiet period: `Sometimes(node-2 fetched a body from node-3 while node-3 was Private)`.

`Always` for the mode invariants, which are pure state relations; `Sometimes` for reaching the relayed state, which is a rare semantic state that should occur at least once.

## Why it matters

A Private node left in Server mode is put in tables by peers (via Identify) but can't be dialled, so lookups route through a dead hop. A node that never takes a reservation is unreachable for bodies and listings: its routes go dark at callers (R7.11). The topology has no NAT box, so this is the only place relay and DCUtR get exercised.

## Open questions

- Can AutoNAT reach `Private` in the Antithesis network at all with inbound-only faults, given `throttle_server_period` (90 s) and 2 peers to ask? If it can't, this property is unreachable in the 3-node topology and belongs in the net-only harness with more nodes.
- Should toggling `light` at runtime stop the node's provider records for fetched bodies (`stop_providing_body`)? Today it serves nothing but still advertises until restart (documented as "from its next start").
