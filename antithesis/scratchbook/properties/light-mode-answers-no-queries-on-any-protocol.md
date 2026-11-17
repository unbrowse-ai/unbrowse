---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
focus: 11 (wildcard)
confidence: low
---

# "Light mode answers no lookups" — but only Kademlia is switched to client mode

## What led here

R7.23 / the claimed guarantee (sut §4): "A light-mode node seeds nothing it
fetched and answers no lookups." The node has three request-answering surfaces,
and light mode only touches one:

- **Kademlia** (`/unbrowse/kad/1.0.0`): light sets `cfg.serve =
  Serve::Client` (`peers.rs:325-327`), so the Kad behaviour stores no records
  and answers no Kad queries. ✓ matches the claim.
- **Body protocol** (`/unbrowse/body/1`, `share::Served`): light is enforced in
  two places — `share::provide` refuses to announce a fetched body
  (`!own && light → return`), and `share::held` refuses to *serve* a fetched
  body (`if light return None`, `share.rs:122-130`). But a light node **still
  serves its own listed routes' bodies** and still has the `Served` handler
  installed. ✓ "seeds nothing it *fetched*" holds; it does serve its own.
- **Listings protocol** (`ServedListings`, `peers.rs:141-165`): installed
  unconditionally in `start_serving` regardless of light. A light node still
  **answers a `listings` request** for its own listed sites if a peer sends one
  directly to its peer id.

## The odd signal

Light mode is described as "only asks the peer network and answers no lookups."
A light node is not discoverable as a provider (it announces nothing under the
site key in Kad client mode), so in the happy path nobody finds it to send a
listings request. But the dedicated `listings` request-response protocol is not
gated by light at all — a peer that already knows a light node's peer id (from
an earlier connection, a relay, an Identify exchange) can still ask it for
listings and get its own listed routes back. Whether that violates "answers no
lookups" depends on whether the claim means Kad lookups specifically or any
request. The wildcard worry: the three surfaces are gated independently and a
future surface added to `start_serving` inherits no light-mode gate by default.

## Instrumentation (vs existing-assertions.md: none)

- `AlwaysOrUnreachable`: while `settings.light`, no `listings` answer and no
  body-serve for a *fetched* body leaves the node. Body-fetched is enforced;
  listings is not asserted and not gated.
- `Sometimes(a light node answered a direct listings request)` — if this is ever
  observed, it is the finding.

## Open Questions

- Does "answers no lookups" (R7.23) mean Kademlia lookups only, or every
  request-response protocol including `listings`? The Kad text is specific to
  "the hash table"; `listings` is a separate protocol. `(needs human input)`
- Is a light node meant to serve even its own bodies, or truly nothing? Code
  serves own-listed bodies in light mode; the one-line claim says "seeds nothing
  it fetched," which is narrower than "seeds nothing."
