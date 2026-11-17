---
sut_path: <checkout>/harness
commit: e96f00c1e97085c40dd1455335a4d75bd7fb5c09
updated: 2026-10-30
---

# a-site-listed-by-nodes-booting-together-is-found

**Found by the harness's local run on the deck, not by the research pass.**

## Property

When nodes boot together and one lists a route soon after, the other nodes find that site's listings through the
peer network, without any of them restarting.

## Invariant

Liveness: within a bound after the contributor's `list_route` (and after faults stop), a caller's
`GET /v1/routes?q=<site>` is answered by the peer network (its reply carries `checked`) and names the entry.

## What the deck showed (e96f00c1)

Three nodes in live mode, booted together (`antithesis/config/docker-compose.yaml`). The workload listed node-1's
routes about a minute after the nodes' APIs answered.

- For the next 10+ minutes neither caller's search was answered by the peer network: it fell back to the chain scan
  (no `checked`), and every paid call failed `502 "no node answered with the entry's signed listing"`.
- The nodes were registered (three `Registered` identities with `unbrowse.peerId` and `unbrowse.addrs`) and connected
  (10 established TCP connections on 4001 each). The SUT's admission assertions show admissions happened.
- Restarting node-1 (the contributor) didn't help. Restarting the two callers did: within a minute both searches were
  answered by the peer network. This happened with every node announcing its address, and with AutoNAT deciding too.

## Suspected mechanism (code reading, not yet proved)

- A node connects (`Net::start`) before it has published its ERC-8004 metadata (`peers.rs`: publishing follows
  `Net::start`). A peer that judges it in that window reads no identity, and `judged` refuses it for `refusal_ttl`
  (600 s, `crates/net/src/node.rs`).
- While a peer is refused, a provider record it sends is dropped (`InboundRequest::AddProvider` with
  `Some(Standing::Refused)` falls in `Some(_) => {}`), and it is out of the routing table, so a `GET_PROVIDERS` never
  reaches it.
- The contributor announces a site once when it lists (`peers::provide`) and once at start; provider records are
  republished only every `provider_refresh` (24 h). A record dropped in the window is gone for a day.
- Restarting the callers clears their refusals, so the contributor (which stored its own record) is admitted and
  answers their next lookup. Restarting the contributor re-sends the record while the callers' refusals still stand.

## Antithesis angle

- Workload: `eventually_network_recovers.py` ("after faults stop every caller finds the contributor's listing
  through the peer network") fails whenever a node restart under faults reopens this window.
- SUT, worth adding: `Sometimes` at the dropped `AddProvider` arm ("a provider record from a refused peer was
  dropped"), and `Reachable` when a refusal for "no identity" is later followed by an admission of the same peer.
- The harness's setup waits for every node's `peer-published.json` and then `refusal_ttl` before listing, so the
  drivers start from a formed network; that is a workaround in the harness, not a fix.

## Open questions

- Should a refusal for "not registered" be shorter, or re-checked when the peer's metadata appears (a `MetadataSet`
  for its identity)? Should a node re-announce its sites when a refused peer is admitted?

## Confirmed and fixed (branch `harness-defects`, from ddb3b462)

Two net-crate tests in `crates/net/tests/liveness.rs` showed the mechanism on the code before the fix:

- `a_site_listed_by_nodes_booting_together_is_found`: two registered nodes form a network; a third dials them
  before it is registered (each reads it `Standing::Refused`), then registers and provides a site at once. Neither
  caller's `find` named it within 45 s ("timed out"): the refusal for "not registered" stood its full `refusal_ttl`.
- `what_a_node_announced_before_it_was_listed_is_found_once_it_is`: the same with `refusal_ttl` cut to 5 s and AutoNAT
  dial-backs off (`probe` = 1 h), the site provided while refused and never again. Still not found in 45 s: once the
  refusal lapsed nothing asked the peer again (only a new connection, a provider record or an `admit` does), and the
  record it sent was dropped. With AutoNAT on, its dial-back's new connection is what re-judged the peer.

The fix (`crates/net/src/node.rs`):

- A refusal for `Unregistered` or `NotItsNode` stands `UNLISTED_RETRY` (3 s), doubling to `UNLISTED_RETRY_MAX`
  (300 s), and the peer is asked again when it lapses while still connected. Other refusals keep `refusal_ttl`.
- Provider records from such a peer are held (within the held bounds) and kept if it is admitted.
- On first admitting a peer, and every `REANNOUNCE_EVERY` (300 s), a node whose table holds fewer than k peers
  announces again every record it provides.
- A hello that failed while the peer stays connected is asked again (`UNREAD_RETRY`) rather than left unjudged.

New SUT assertion: `Sometimes` "a peer turned away as not listed was admitted once the registry listed it". The
workload's setup no longer waits for `peer-published.json` and `refusal_ttl`; it lists as soon as the nodes answer.
