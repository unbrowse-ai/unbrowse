# Routes and the registry

## What a route is

A **route** is the saved result of walking a website: everything needed to replay the site's own internal API call without a browser (spec R2.1).

- **Method & URL template:** e.g. `GET /api/search?q={q}` or `POST /items/{id}`.
- **Headers, body & response shape:** what the endpoint expects and the JSON structure it returns (field names and types only — never cached answer values).
- **Setup steps:** any prerequisite requests that mint a CSRF token or public cookie.
- **Value provenance:** where every value comes from — a caller input, a public constant, an earlier step's response, the caller's own session, or page code.

When shared to the network, a route is compiled into a **recipe body** (`unbrowse.recipe/1` or `/2`). A recipe is pure data, never executable code, and **never carries secrets**: all cookies, tokens, passwords, and personal values are stripped or rejected before publishing. If a route requires a login, the recipe names the *kind* of session needed and each caller supplies its own locally (spec R2.2, R2.10).

Every recipe body is content-addressed by its **content identifier** (`sha256:` over canonical JSON). Any change to the recipe produces a brand-new ID (spec R2.4).

## Listing and credit

Sharing a route to the open index is called **listing**:
- Your node signs a listing record binding the route ID, recipe content ID, contributor identity, version, description, response shape, and USDC price (spec R2.14).
- Listing is **free** — it requires no bond, locks no tokens, and writes nothing per listing on chain (spec R2.15).
- Before spreading a listing, a Merkle root covering the listing hash is posted on chain (by the reserve poster or by the node) so the block timestamp proves when it existed (spec R2.17–R2.20).
- Each unique recipe hash can have at most one **route stake**. Exact copies share the same content ID and cannot open duplicate stakes; an improved or fixed recipe has a new hash and competes on rank ([Payments, Staking & UNB](payments-and-unb.md)).

## A peer-to-peer map with no central host

No company hosts the index. Routes live on users' machines, discovered via a **Kademlia distributed hash table (DHT) keyed by site** (`/unbrowse/site/<registrable domain>`):
- Because agents almost always know which website they want, lookups target that site's exact key.
- A node fetches signed listings from at least two independent identities and ranks them locally (spec R7.21).
- Any node that fetched and kept a working recipe can seed its bytes to other peers. Seeding requires no bond and earns no fee cut; payment always follows the signed listing.

## Fetching someone else's route

1. **Discover (free):** Query the DHT for the site's listings and verify each signature and on-chain status.
2. **Fetch & verify:** Request the recipe bytes from a provider with a signed voucher, then verify the bytes match the listing's `sha256:` content ID and pass the local credential scanner (`crates/detector`).
3. **Run locally:** Replay the recipe straight from your machine to the website, restricted to HTTPS and public internet addresses (`Egress::Foreign`). Nothing passes through the node that served the recipe.
4. **Pay only if it passes:** If the mechanical check passes, the voucher line is marked passed (paying once per version and keeping the recipe cached for free reuse). If it fails, you pay **$0** and fall back to the next route or your browser.

## In the code today

**Built:**
- **Recipe compilation & leak prevention:** `recipe::of_route`, `recipe::check`, and `recipe::content_id` in `unbrowse-node/app/src/recipe.rs`, plus the pinned credential detector (`unbrowse-node/crates/detector`).
- **Signed listings & Merkle roots:** `listing::publish`, `listing::verify` (`app/src/listing.rs`).
- **DHT discovery & fetching:** `unbrowse-node/crates/net` (`Net::find`, `fetch_body`) and `app/src/peers.rs`, `share.rs`.
- **Automatic sharing:** `app/src/autolist.rs` (`used` mode by default: lists routes that pass on 3 different days or 5 times, up to 5/day; configurable to `all` or `off`).
- **Live delisting & site policies:** Gossipsub change notices (`share::announce`, `share::on_change`) and on-chain site policy checks (`app/src/sitepolicy.rs`).
- **Route-staking integration:** `app/src/chain/coins.rs` and `rank/coin.rs`.

**Differences & not built yet:**
- **Entry IDs:** In the current implementation, each entry ID is derived from the contributor's route ID (`keccak256("unbrowse/entry/" || route_id)`) rather than a canonical endpoint hash `H(d || m || u || σ)`.
- **Host binding:** Enforces registrable-domain matching (kind a) and verified site-policy hosts (kind b); browser-observed dynamic binding (kind c) is not built yet.
- **Not built yet:** `robots.txt` opt-out (`User-agent: Unbrowse`, spec R4.32), hourly reserve root-posting service (nodes post their own roots today), and optional network-wide index nodes (spec R1.6, R2.26).

Related: [How it works](how-it-works.md) · [Search and ranking](search-and-ranking.md) · [Sharing routes](../SHARING.md).
