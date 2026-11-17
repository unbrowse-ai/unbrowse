# node-on-network-after-first-publish-fails

**Focus:** 7 Distributed Coordination (with lifecycle overlap). **Confidence:** medium-high (unconditional code path; not exercised by a test here because it needs the app crate and a chain).

## Claim being tested

`peers.rs:369`: "A write that fails is tried again at the next check." That is said of the republish loop. `peers.rs:306-307`: the node "joins the peer network as the owner's identity ... and announces every site the node has listed routes for and every body it serves". R7.18 and R7.21: a node seeds its bodies and announces its sites.

## Code paths

- `peers.rs:345`: `Net::start_with_bodies(...)` spawns the swarm task and `join` (`node.rs:348-350`). From here on, the swarm runs for the life of the process: `join` holds a `Net` clone, so the command channel never closes.
- `peers.rs:352-358`: if `settled_addresses` finds any address, `publish(...).await?` runs. `publish` → `erc8004::publish` (`erc8004.rs:139-162`) makes `getMetadata` reads and up to 4 txs, each awaiting a receipt. **Any chain error returns `Err` from `peers::start`.**
- The code after it never runs on that path: the republish loop (`:359-376`), the announce task for own sites and bodies (`:378-405`), and the `Ok(net)` return.
- `main.rs:1425-1430`: `Err(e) => eprintln!(...)`, with no retry. `n.net` (a `OnceLock`) is never set.
- Consequences, each reading `node.net.get()`: `share::fetch` fails "the node isn't on the peer network" (`share.rs:259`); `peers::find_signed` returns `None` (`peers.rs:550`); `peers::provide` and `share::provide` do nothing (`peers.rs:417`, `share.rs:176`); `hold_tick` announces nothing (`peers.rs:509`).
- The detached swarm still answers hello (`node.rs:1009`), listings from `ServedListings` (`peers.rs:141`) and bodies from `Served` (`share.rs:113`), and it dials saved peers and seeds, so peers see it as present and admitted.
- `erc8004::ensure` failing earlier (`peers.rs:317`) also returns `Err`, but before any swarm starts: the node is simply off the network, also never retried.

## Failure scenario in Antithesis

Node termination while the node→chain link is partitioned (or the chain container hung), so the restarted node's first publish fails. A cold start during a chain partition does the same. After faults stop, the node never becomes a full participant. It can't find or fetch any listing, its own sites and bodies are never announced (unless kad's republish of records from a previous run happens to fire, and those are in-memory and lost on restart), and if its IP changed, its new address is never written to the registry, so seeds and contributors' lookups (`share.rs:264-266`) point at the old one.

## Invariant and assertions (all missing)

- Workload liveness after `ANTITHESIS_STOP_FAULTS` + recovery window: for every node with `peer_network` on, `Always(GET /v1/routes?q=<site> from that node finds another node's listing)` and `Always(registry metadata unbrowse.addrs for its identity ⊆ addresses the node listens on)`. Message: "every node is fully on the network after the chain recovers".
- SUT-side at `main.rs:1429`: `Unreachable("peers::start failed after the swarm started")`. Distinguishing this from the `ensure` failure needs `peers::start` to report which step failed. As written, `Reachable` on that line marks the fault timing.
- SUT-side in `peers::start` after `Net::start`: `Always(returned Ok || the swarm was not started)`. This is the direct violation check.

`Always` after the quiet period: once the chain is back, full participation must hold every time it is checked. The SUT-side check flags the half-joined state the moment it happens.

## Why it matters

The node looks healthy to its peers (it answers and serves) while its own agents get "not on the peer network" for every network route, and its owner's routes stop being announced. Only a restart fixes it, and a restart while the chain is down repeats it. In the topology, `node-1` is the contributor, so one unlucky restart hides the only listed route.

## Open questions

- Should the first publish failing be non-fatal (log, keep `last` empty, and let the 30 s loop retry), like later failures? That looks like the intent of `peers.rs:369`.
- Should `main.rs` retry `peers::start` (both the `ensure` and the publish failure) with backoff? The deployment's "start-up and peer join never retry" (sut-analysis §5.10) is the same class.
- Does any status surface (owner API, `whoami`) report the half-joined state? If not, the workload can only see it through failed lookups.
