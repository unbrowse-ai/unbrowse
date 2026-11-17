# checked-lookup-spans-two-identities

**Focus:** 7 Distributed Coordination, 4 Protocol Contracts. **Confidence:** high that it is the right property. Holds structurally; it inherits any admission defect.

## Claim being tested

R7.21: "A seeker ... fetches the site's signed listings from at least 2 of them that belong to distinct identities; several nodes of one identity count as one source." AGENTS.md: "One owner is one source." "Standing is read from the registry, never from the peer." `Found.checked` doc (`node.rs:164-165`).

## Code paths

- `Net::find` (`node.rs:371-389`): providers from Kademlia → `counted()` admits each (`node.rs:393-409`) → keeps one peer per identity (`by_identity`) → fetches each → `sources` gets the identity of each source whose fetch returned `Ok` → `checked = sources.len() >= listing_sources` (2).
- Identity comes only from `Standing::Counts(id)`, which comes from `admitted` (`node.rs:681-684`), set only by `judged(Ok)` after a registry read (`node.rs:897-909`). So the claim depends on admission being right: the version gate bypass (`too-old-peer-never-counts`) and stale 24 h admissions both feed in.
- A source that answers an empty list still counts (`node.rs:383-384`). Lookups in `peers::find_signed` then drop listings that fail `listing::verify`, but `checked` is computed before that and passed through unchanged (`peers.rs:567`). So `checked` can be true with every listing from one source discarded.
- Existing coverage: `crates/net/tests/network.rs:81-127` (two nodes of one identity are one source; an unlisted node never counts). No faults.

## Failure scenario in Antithesis

Net-only harness with 4 identities, one of which runs 2 nodes. Partitions split the providers, nodes restart (losing `admitted`), and registry reads are delayed. A custom fault changes an identity's registered peer IDs mid-run, to probe the 24 h admission cache. The full topology checks the same through `GET /v1/routes` (`checked` as the API reports it).

## Invariant and assertions (all missing)

- SUT-side at `node.rs:387`: `Always(!found.checked || distinct(found.sources).len() >= self.sources)`. That holds by construction; the meaningful part is in the next line.
- SUT-side at `node.rs:384`: `Always(registry.identity(id) lists p at the time of the fetch)` for each counted source. That is costly (a read per source), so use it in the harness only. Message: "every lookup source is a peer its registry identity lists now".
- Workload: `Always(found.sources has no duplicates)` and `Always(checked ⇒ two distinct identities' nodes were reachable during the lookup)`, compared against the harness's own view of the registry and partitions.
- `Sometimes(found.checked)` under partitions: "a checked lookup happens while one provider is partitioned away". This is the liveness side, and it needs at least 3 providing identities.

## Why it matters

`checked` is the network's defence against one source hiding listings (R3.7). A false `checked` tells the agent's ranking that an omission would have been caught when it wouldn't. The deployment's 3-node topology can reach `checked` only with a holder re-serving node-1's listing (deployment-topology.md), so this also exercises the holder path.

## Open questions

- Should `checked` be computed after verification (counting only sources that contributed at least one verified listing, or that answered at all)? As written, a source that answers garbage counts.
- Should a peer the registry stops listing stop counting before `admission_ttl` (24 h) runs out? R7.26 caches for an epoch, so the answer is probably no, but then the invariant must allow a 24 h lag.
- Is a 4th node worth adding to the topology for this property (deployment-topology.md open question)?
