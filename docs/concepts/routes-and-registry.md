# Routes and the registry

## A route

A route is the saved result of a walk: everything needed to make a site's own call again without a browser (spec §2.1).

- a **method** and a **URL template**, with your inputs as holes (`/search?q={q}`, `/item/{id}`);
- the **headers and body** the site expects, and the **shape** of its answer: field names and types, no values;
- the **setup calls** the winning call depends on (the one that set a cookie, the one that minted a token);
- for each value, **where it comes from**: your input, a constant, an earlier answer, your own session, or page code.

What is shared is the route's **body**, a recipe for making the call. It is data, never code, and it never carries a
secret: no cookie, token, password or session value. A call that needs a sign-in names the *kind* of session it needs,
and the caller supplies its own (R2.2, R2.10).

A body is named by its **content identifier**, a hash of its exact bytes. The same body always has the same id, and
any change gives a new one (R2.4).

## Listing, and who gets credit

A contributor shares a route by **listing** it: a record its key signs, naming the route, the body's content id, the
contributor's identity, a version and its terms (description, answer shape, price). Before it spreads, the
contributor's node posts a **Merkle root** over its new listings on chain. A root posted at block *t* proves the
listing existed by then, so nobody can copy a body and claim to have been first (R2.14, R2.17, R2.19).

Listing is free: it writes nothing to the chain per listing, locks nothing, needs no bond and launches no coin (R2.15).

Many contributors may list entries for the same route. Each is an **entry**, and entries compete for its calls. In the
design an exact copy of a body is the same entry, credited to the earliest listing, and anyone can show an earlier root
to move the credit (R2.18). Each entry may have one **route coin**, named by its body's hash, so an exact copy can't
launch a second coin; a changed copy, or a fix for a broken route, is a new entry with its own coin and competes on
rank (`coin.per-entry`). The credited lister may make the coin's launch buy, takes a bounty's lister coins, and is paid
the route's share while no coin is staked and checked ([Payments and UNB](payments-and-unb.md#route-coins)). The
rule names are those of the specification ([`papers/protocol.md`](../../papers/protocol.md)).

## Nobody hosts the map

The map lives on its users' machines, the way BitTorrent stores files. Any node that holds a body may serve it, and
advertises itself in a distributed hash table. Seeding earns no share of the fee: payment follows the signed listing,
not the server. The same table finds a site's listings: an agent almost always names the
site it wants, so the site's name is the key. A seeker fetches signed listings from at least two holders run by
different identities and ranks them on its own machine (R7.21). The chain records who listed, served and paid; it does
not store routes.

## Fetching a route someone else learned

1. Your node looks up the site's listings in the table (free) and checks each one.
2. It fetches the body from a node that holds it and checks the bytes against the listing's content id. A node that
   serves altered bytes is caught at once (R7.19).
3. It runs the route under your own session, straight to the site. Nothing passes through the node that served the
   body.
4. If the use passes, it pays the route's fee, keeps the body and reuses it with no new payment while that version
   works (R3.12). The fee also buys the route's coin for you, staked. A failed use costs you
   nothing.

If no node can serve a route, the agent falls back to the browser and learns it again: the network degrades to slow,
never to broken.

## In the code today

**Built.**

- **Route coins are built.** The contracts are in [`unbrowse-settlement/src/coins/`](../../unbrowse-settlement/src/coins/README.md) (the coin, its curve, staking, the fetch path and bounties), Settlement pays the 65 / 30 / 5 split and calls them on every claimed line, and the node trades, stakes, claims and ranks through them (`unbrowse-node/app/src/chain/coins.rs`, `rank/coin.rs`). The earlier economy (entry bond, route pool, fraud court, HTTP domain witnesses) is removed. Nothing is deployed yet: Arc mainnet has no deployment, and the earlier Arc testnet contracts are no longer supported.
- The body: `recipe::of_route` compiles a route into `unbrowse.recipe/1` (or `/2` when it has optional inputs or a next page), refusing rather than scrubbing a route that
  would carry anything of the session; `recipe::check` runs on both sides; `recipe::content_id` is `sha256:` over
  canonical JSON. [SHARING.md §1](../SHARING.md#1-routes-as-recipes).
- Signed listings and posted roots: `listing::publish` (sign, keep, `postRoot`), `listing::verify` (signature against
  the ERC-8004 identity, root posted, entry live). [SHARING.md §2](../SHARING.md#2-signed-listings-under-posted-roots).
- Finding by site, from two identities: `crates/net` (`Net::find`) and `peers.rs`;
  [NETWORK.md §4 and §5](../NETWORK.md#4-site-keys-and-provider-records).
- Paying, fetching, checking, keeping and running a body: `api/call.rs` `call_entry`, `share::fetch`, `recipe::verify_body`,
  `share::keep`. [SHARING.md §3](../SHARING.md#3-how-a-caller-finds-pays-for-keeps-and-runs-a-body).
- Sharing by itself: `autolist.rs`, in `used` mode by default (a route that ran on 3 days or 5 times), `all` or `off`.
  [SHARING.md §4](../SHARING.md#4-automatic-sharing).
- A delist reaching kept copies: `share::still_listed`, `share::check_kept`.
  [SHARING.md §5](../SHARING.md#5-a-delist-reaches-kept-copies).

**Differs from the design.**

- **An entry is one contributor's route, not a route identity.** The spec names a route by `H(d ∥ m ∥ u ∥ σ)`, so
  every contributor's entry for the same endpoint competes under one id (R2.3). The code's entry id is
  `keccak256("unbrowse/entry/" ‖ route id)` (`chain::entry_id`), and a route id is the node's own (from its walk). So
  two contributors who learn the same endpoint list two unrelated entries.
- **Credit goes to whoever listed the entry, not to the earliest root.** The contract records the first `listEntry` of
  an entry id as its contributor (`listEntry`, `EntryTaken`). It never reads a listing or its root at claim time, and
  there is no `correctCredit` (R2.18, R3.22). Copying is stopped on the client instead: a node refuses to list a body
  it fetched from another contributor (`main.rs` `list_route`).
- **Signed-in routes.** The spec lists a route learned behind a sign-in like any other (R2.13). The code lists a route
  learned from the owner's own browsing as its recipe, with placeholders, once the node is on the network, and refuses any
  whose body would need a credential removed to be shared (`recipe::of_route`). A body that needs a cookie session is shared, and the caller's own session supplies it.
- **Host binding** is the registrable-domain rule, kind (a): a session value or secret goes only to hosts on the
  site's registrable domain (`share::bound`, R2.27), and to the hosts a proven site lists in its policy, kind (b)
  (`app/src/sitepolicy.rs`). The browser-seen kind (c) is not built.
- **The content id is settled.** The spec leaves open which bytes it covers (R2.5); the code fixes it as SHA-256 over
  canonical JSON.

**Not built yet.**

- A site delisting its own routes by a robots group naming `Unbrowse` (R4.32). Delisting by site policy is built: the
  node reads `Domains.policyOf` and takes a delisted site's entries out of the live set (`app/src/sitepolicy.rs`,
  R4.17).
- The reserve posting a root every hour for contributors that won't front the gas (R2.20): each node posts its own.
- Registry snapshots and index nodes for intents that name no site (R2.26, R1.6).

Related: [How it works](how-it-works.md) · [Search and ranking](search-and-ranking.md).
