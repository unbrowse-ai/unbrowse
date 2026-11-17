# nodes-booting-together-find-each-other

**Focus:** 7 Distributed Coordination. **Confidence:** high (confirmed by probe).

## Claim being tested

R7.24: "A node joins by dialling the peers it saved when it last ran. Only when none answers does it read the identities' metadata on chain and dial registered nodes from it; there is no bootstrap list." R1.15: "Clients find peers ... from this metadata." The deployment's `eventually_network_formed` command expects every node to find every other after a quiet period.

## Code paths

- `node.rs:558-586` `join`: dials the saved table **once**, sleeps 3 s, and if the table is empty reads `registry.seeds()` **once** and dials them. It then loops every 2 s until the table is non-empty, never re-reading seeds or re-dialling saved peers. After the first non-empty table it bootstraps every 600 s.
- `erc8004.rs:218-237` `seeds()`: `chain::logs(...).unwrap_or_default()`, so a chain error yields no seeds, silently. `read()` returns `None` per identity on any error.
- Publishing happens after `Net::start`: `peers.rs:345` (start), `:352` `settled_addresses` (polls up to about 3-8 s), `:356` `publish` (`erc8004::publish`: up to 3 `setMetadata` txs plus `setAgentURI`, each awaiting a receipt). A node is a seed only after its `unbrowse.peerId` `MetadataSet` log exists (`seeds()` filters on that topic).
- Live mode (`Serve::Auto`): no peer is a Kademlia server until AutoNAT confirms it (`probe` = 15 s, `node.rs:139`, `autonat_config`), so at the 3 s check the table is always empty in live mode. That part is fine (seeds are always read), but it means the saved-table branch never decides.
- `Cmd::Dial` with `PeerCondition::Disconnected` (`node.rs:851`): a failed dial is not remembered or retried.

## Probe evidence (`antithesis/scratchbook/probes/net-probe.rs`, `probe_join_reads_seeds_once`)

Two nodes start together and register (publish) 4 s after start, i.e. after their first seed read. That is the order `peers.rs` imposes whenever publishing takes more than about 3 s.

- 30 s after both published: **A's table 0 peers, B's table 0 peers; seed reads total 2** (one each, none after publishing).
- A third node booting later reads both as seeds; then all three have 2 peers. The network forms only because a later node dialled in.

Discriminating detail: both identities were readable as seeds for 30 s, and no further read happened.

## Failure scenarios in Antithesis

1. **Simultaneous boot.** All three node containers start together on a fresh chain. Each node's 3 s read precedes the others' `MetadataSet`. Every node waits forever for an inbound dial.
2. **Chain unreachable at boot.** A node→chain partition covering t = 3 s: `seeds()` returns `[]` and nothing retries. Combined with node termination (a restarted container may get a new IP, faults.md), the saved table points at addresses that may have moved, and the restarted node's own new address is published only if `peers::start` gets that far (see `node-on-network-after-first-publish-fails`).
3. **Saved peers partitioned at boot.** The one dial of each saved peer fails, and it is never retried.

## Invariant and assertions (all missing)

- Workload, `eventually_network_formed` (or a mid-run check after `ANTITHESIS_STOP_FAULTS` + 60 s): `Always(for every pair of live, registered nodes, b.peer_id ∈ a.table())`. Message: "every pair of registered nodes is in each other's table after a quiet period".
- SUT-side in `join` after the seed read `node.rs:573`: `Sometimes(seeds.is_empty())` ("join read no seeds") and `Reachable("join found the table empty after seeding")`. These anchor the fault timing.
- SUT-side in the 2 s loop `node.rs:575`: `Always(waited_for_table < 120s || seeds_reread)`. It holds only if the code re-reads, so this is the direct violation signal, and it can be checked during faults. Message: "a node with an empty table re-reads its seeds within two minutes".

`Always` after the quiet period suits a liveness guarantee checked at a point when it must already be true. The SUT-side `Always` on the waiting loop catches it without waiting for the end of the run.

## Why it matters

A node that misses its one seed read is invisible: it can't find listings, providers or relays, and nobody finds its routes, until some other node happens to dial it. In a young network (few nodes, all started by one operator, or restarted together after an upgrade) that can be every node. Nothing logs it.

## Open questions

- Is a single seed read intended (relying on inbound dials), or should `join` re-read seeds (with backoff) while the table is empty? R7.24 describes first contact only.
- In live mode the table is always empty at 3 s (AutoNAT has not confirmed anyone yet), so "only when none answers" is never what decides. Is reading seeds on every start acceptable as the reading of R7.24?
- Does `peers.rs:384-396` (announce own sites after waiting up to 120 s for a table) leave an isolated node's site records only in its own store, unfindable in a network larger than k? In a 3-node topology every node is among the k closest, which masks this.
