# unbrowse-net

The node's peer network. No node holds the whole map of routes: a node stores what it holds and what it uses, and
finds the rest through a Kademlia table keyed by site, and each route's body by its content id. The design is spec
§52 and §53 in the papers (protocol R7.18 to R7.26).

| Module | What it does |
|---|---|
| `site` | The key a site is found under: `/unbrowse/site/<registrable domain>`, so every page and subdomain of a site meets at one key |
| `position` | Where a node sits in the table. A node's position must start with bits drawn from its identity and the hash of the block that registered it, so it can't grind keys to sit next to one site's key |
| `admission` | Which peers count: the registry lists the peer ID under the identity it names, and the peer sits where that identity's node must |
| `body` | Route bodies as opaque bytes: the key a body's providers are recorded under, `/unbrowse/body/<content id>`, and `/unbrowse/body/1`, where a caller asks a provider for one and pays for it |
| `budget` | What the node does for each peer, bounded: a token bucket per peer and protocol (listings, bodies, Kademlia streams), with peers that failed admission sharing one more; serving slots that go to the peers that paid for bodies first, with one kept for a newcomer; a refusal at once past any of them |
| `changes` | Change notices over gossipsub, one topic a site: a contributor's node says it delisted or repriced entries, and the nodes that keep or serve them read the chain again at once. Only signed notices from admitted sources are read; the topic uses gossipsub's peer scoring, tuned for a quiet topic |
| `providers` | Which of a body's providers a caller still tries: one that failed is set aside for that body on the doubling schedule, `min(2^(k-1), 32)` epochs on its `k`-th failure; kept on disk across restarts (`Providers::open`, `load_kept`, `save_kept`) |
| `tower` | `/unbrowse/tower/1`: a node hands a peer one stream's signed running voucher and lines, as opaque bytes, for the peer to claim if the node doesn't; the peer's node keeps them through the `Towers` trait (`Net::start_with`) or says why not (`HandError::Refused`). 256 KiB a hand-over, 8 checked at once, each peer a burst of 16 then one every 5 s |
| `node` | The running swarm, and the handle the node uses: `provide` a site, `find` a site's listings; `provide_body`, `find_body_providers`, `fetch_body`; `hand_over`; `stop`, a clean goodbye; the table's own liveness check |

## How a lookup runs

1. The seeker hashes the site's name and asks the table for the site's providers (`GET_PROVIDERS`).
2. It keeps the providers that count, at most one per identity: several nodes of one owner are one source. It meets
   those connected now first, then those seen within a record's life, then the rest, and counts one not connected
   only if it is reached within `connect_timeout`, so a provider that has gone never holds a lookup up long.
3. It asks each for the site's listings over `/unbrowse/listings/1` and drops any listing for another site.
4. `Found::checked` says whether `listing_sources` distinct identities answered, enough to catch one leaving listings out.

The node checks each listing against the chain before an agent sees it (`app/src/peers.rs`).

## How a body is fetched

A body is a route's recipe, named by its content id. This crate never reads one: it carries bytes, and the node
checks what it is served against the content id in the signed listing, so a provider can serve a body but can't
change it (R7.19).

1. A node that holds a body announces it (`provide_body`): a provider record under the body's key, refreshed every
   20 minutes and valid for an hour, the same as a site's. `stop_providing_body` stops the refresh; records on other
   peers lapse within the hour. A node that stops cleanly (`Net::stop`) withdraws them all at once with a signed
   leaving notice to its peers.
2. A caller looks up the body's providers (`find_body_providers`): those that count, at most 20, each identity's first
   node before any identity's second, so one owner running many nodes can't fill the list.
3. It asks one over `/unbrowse/body/1` with its payment (`fetch_body`). The provider's node answers through the
   `Bodies` trait it was started with (`Net::start_with_bodies`): it judges the payment and returns the body, or the
   reason it won't, which reaches the caller as `FetchError::Refused`.
4. A provider that doesn't answer, or serves bytes that don't match, goes into the caller's `Providers` and is passed
   over for that body until its exclusion ends.

The wire is bytes, not JSON. Its bounds:

| | Bound |
|---|---|
| Content id | 256 bytes |
| Payment | 4 KiB |
| Body | 64 KiB. A provider's node refuses to send a larger one; a caller reads one byte past the bound and stops (`FetchError::TooLarge`) |
| Refusal reason | 512 bytes, cut |
| Caller's wait | 15 s; the provider's store gets 10 s of it, so a slow store is a refusal, not a silence |
| Asks answered | each peer a burst of 20, then one a second, admitted or not (R7.26); 16 at once, the next free slot to the peers that paid most, one kept for a newcomer (`budget`) |

## Who gets in

Meeting a peer is not trusting it. On every connection each side names its identity over `/unbrowse/hello/1`. The
routing table takes peers only by hand (`BucketInserts::Manual`) and provider records only through the node
(`StoreInserts::FilterBoth`), so both wait for the verdict:

- the Noise handshake has proved the peer holds its peer ID's key;
- the registry lists that peer ID under the identity it named;
- its index is below `nodes_per_identity`, and its position starts with the identity's target bits.

A peer that fails can still ask questions, within a budget all such peers share (`budget`); it never enters a routing
table and its provider records are dropped.

## Joining

The saved routing table first; the registry's seeds only if none of those peers counts any more; then a lookup of the
node's own ID, which fills its buckets. Every dial the node makes, and every dial the table and the request
protocols make by peer, opens a port of its own, so two nodes that dial each other at the same moment, as nodes that
boot together do, get two connections rather than one neither can secure.

## Being reached

A devnet's nodes share one machine and listen on loopback (`announce_listen`). Elsewhere a node listens on every
interface, and three protocols settle how others reach it:

- AutoNAT asks connected peers to dial it back. A private address counts once a peer dials it: on a LAN or a tailnet
  the nodes that reach it are on that network too. Under `Serve::Auto` a node serves the table while it is reachable
  and only asks it while it isn't; `Serve::Server` and `Serve::Client` fix it.
- Circuit relay v2. A reachable node relays for others, with a few reservations and short, small circuits. A node
  AutoNAT finds unreachable holds reservations on up to two admitted peers that relay, and its relayed address is
  one it publishes.
- DCUtR turns a relayed connection into a direct one by punching through both routers.

What a node publishes (`reach::published`) is what another machine could dial: the addresses its owner names
(`announce`), those peers confirmed, and its interface addresses, never loopback, unspecified or link-local. A peer's
own loopback addresses are dropped too, outside a devnet.

## Not built yet

- A provider that only asks the table (one behind a router) is fetched from only if the seeker already has an
  address for it: the addresses in its provider record last only as long as the lookup.
- Rate limits on provider queries per peer: Kademlia answers `GET_PROVIDERS` inside its behaviour. Listings and
  bodies are rate-limited, listings across all peers and bodies per peer as well.
- A real anchor without ERC-8004. On a devnet that forks nothing, the folder stand-in draws each node's anchor from
  its address, so a node there is placed but nothing stops an identity from choosing its address.
- One identity with several nodes publishing at once: the node writes index 0 of its identity's metadata.
- Remote calls still go over the contributor's HTTP endpoint, not a libp2p protocol.

```bash
cargo test -p unbrowse-net    # unit tests; six nodes over TCP, one unlisted, one identity with two nodes; two nodes
                              # on every interface reaching each other at the addresses they publish; a body found
                              # by content id and fetched, refused, and cut off from a provider that floods
```

## Licence

[Apache-2.0](../../../LICENSE).
