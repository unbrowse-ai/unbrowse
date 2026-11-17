# Listings without an on-chain write

How a route gets listed today, how it is listed once listing is peer to peer, what changes in Settlement and in the
node, what it saves, and how the move happens without breaking a node that still lists the old way. Written for
engineers changing Settlement or the node's listing code. The normative rules are protocol R2.14 to R2.21 and R2.14a
(spec §38.2, §70.1 item 4); what a listing record carries is in [SHARING.md §3](SHARING.md); what any of it costs is
in [MONEY.md](MONEY.md).

- [1. Today](#1-today)
- [2. The target](#2-the-target)
- [3. Settlement: what is built](#3-settlement-what-is-built)
- [4. The node: what is left](#4-the-node-what-is-left)
- [5. Gas, before and after](#5-gas-before-and-after)
- [6. Escrow, delisting and the signer, with no entry written](#6-escrow-delisting-and-the-signer-with-no-entry-written)
- [7. Migration](#7-migration)
- [8. Risks and open points](#8-risks-and-open-points)
- [9. Phases](#9-phases)

---

## 1. Today

A node lists a route with three things (`main.rs` `list_route`):

1. **`listEntry(entryId, domain, description)`** on Settlement, where `entryId = keccak256("unbrowse/entry/<route
   id>")`. It writes the entry (contributor, domain hash, live, tenure) and, the first time, joins the wallet to the
   network. 182,951 gas for a wallet's first route, 108,442 for each later one (MONEY.md §4).
2. **A signed listing** (`listing::publish`): the owner key signs `Listing { routeId, site, contentId, agentId,
   version, supersedes, terms }` as EIP-712 typed data under Settlement's domain.
3. **`postRoot(root)`** over every listing not yet under a root: 46,653 gas.

Readers keep a listing only when its signature is the contributor identity's key, its root is posted, and the chain
holds a live entry for it, the same contributor's and for the same site (`listing::verify`). So every listing costs one
`listEntry`, and automatic sharing (R2.14a) spends gas on every route it shares. That is what R2.15 forbids: listing
must write nothing to the chain per listing.

## 2. The target

- A listing is a record signed by its contributor's key and spread between nodes, through the site-keyed hash table
  (R2.14, R2.15). Nothing is written to the chain per listing.
- The chain sees only **roots**: `postRoot` over a batch of listing hashes, any number of listings per write, by
  anyone, with no bond (R2.17). A contributor's node posts a root holding its listing before spreading it (R2.19); the
  rewards reserve posts one every `listing.reserve_root_interval` for nodes that won't front the gas (R2.20).
- The chain learns a listing only at its **first claim**: the claim carries the listing, its signature and its proof of
  inclusion in a posted root, and Settlement records whom the content id is credited to (R2.18).
- **Earliest root wins.** For a content id `c`, the credited listing is the one in the root posted at the lowest block
  holding a listing of `c`, ties broken by leaf order. Anyone may show an earlier one with `correctCredit`; later
  claims are then paid to its contributor, and claims already made stay paid.
- `listEntry` was the legacy path while nodes moved; the deployment of spec §76.1 has none (§4).

## 3. Settlement: what is built

`unbrowse-settlement/src/lean/Listings.sol` is new; `LeanSettlement.sol` gains one function. Settlement is close to
EIP-170's 24,576 bytes, so the checks live in their own contract (6,857 bytes), which Settlement deploys in its constructor and
names as `listings()`. Settlement takes one new constructor argument, the chain's ERC-8004 IdentityRegistry (zero on a
devnet without one).

**Entry ids are content ids.** A listing's content is paid under `entryIdOf(contentId) = keccak256("unbrowse/content/"
‖ contentId)`, so identical copies are one entry (R2.21) and a new version of a route's body (R2.6) is a new entry with
its own first claim. `listEntry`'s ids (`unbrowse/entry/<route id>`) are another namespace; the two never collide by
accident.

**The listing as signed.** The struct and EIP-712 type are the node's `SignedListing` (`listing.rs`), field for field,
under Settlement's domain (`Unbrowse Settlement`, `1`, chain id, Settlement's address):

```
Listing(string routeId,string site,string contentId,string agentId,uint64 version,string supersedes,bytes32 terms)
```

`terms` is the keccak of the terms' canonical JSON. The leaf of a listing in a root is `keccak256(keccak256(digest))`,
as the node already makes it.

**Roots are positional trees.** The tie-break "by leaf order" needs the proof to show where a leaf sits, which
OpenZeppelin's sorted-pair trees can't: they order each pair by value. A listing root is a plain positional Merkle tree:
`Listings.rootOf(leaf, index, proof)` hashes left-then-right as the index's bits say, a level's odd last node pairs
with zero, a proof is at most 24 levels (16.7 million leaves), and an index past the proof's depth is refused, so one
leaf can't be shown at two places. `test/utils/PosMerkle.sol` builds such trees for the tests. Receipt-line trees are
unchanged (sorted-pair, OpenZeppelin).

**Calls.**

| Call | Who | What |
|---|---|---|
| `Listings.showAndClaim(shown[], vouchers, sigs, lines, proofs)` | any payee | Shows each listing, then runs `claimBatch` with the lines, in one transaction. A first claim. |
| `Listings.show(shown[])` | anyone | Shows listings without claiming. |
| `Listings.correctCredit(shown)` | anyone | Moves a content's credit to an earlier listing. Reverts `NotCredited` if nothing holds it, `NotEarlier` if the listing isn't earlier. |
| `Listings.placeOf(entryId)` | view | Whom the entry is credited to, the block of its listing's root and its leaf index. |
| `LeanSettlement.creditEntry(entryId, contributor, domainHash)` | `Listings` only | Records the credit. |

A `Shown` is `{ listing, sig, root, index, proof }`. Showing a listing:

1. The root must be posted (`rootBlock(root) != 0`, else `NotPosted`).
2. Its place, `(rootBlock, index)`, is compared with the place of the listing now credited (kept in `Listings`). If it
   isn't earlier, `show` returns without checking anything more, so a claim carrying a listing someone already showed
   costs little and never fails for it; `correctCredit` reverts.
3. The proof must climb from the listing's leaf at `index` to `root` (`BadProof`).
4. The signer must be the contributor (below, `BadSignature`, `BadIdentity`).
5. The site is put in canonical form (`canonicalDomain`, `BadDomain`).
6. `creditEntry` records the contributor and site on Settlement's entry. A different contributor than the one holding
   the entry is made its contributor, the entry goes live under its tenure, and it joins the network if it hasn't
   (R6.10). The contributor already holding it keeps its entry as it was, live or delisted: showing its own earlier
   listing moves where its credit sits, never undoes its delisting.

A listing shown outranks a `listEntry` on the same id: an entry made by `listEntry` has no place, so any listing is
earlier. A copier who writes a gossiped content id with `listEntry` before its first claim holds it only until the
first claim that carries a listing.

Claims are unchanged: `_claim` reads the entry's contributor and domain hash from one slot as before. A claim on an
entry nobody has shown a listing for, and that `listEntry` never made, is refused with `UnknownEntry`, as before.

**Tests** (`test/lean/Listings.t.sol`, 23 tests, on a chain without a registry and on one with a mock ERC-8004
registry):

- the first claim credits the signed listing and pays its contributor, the site's escrow and the rest, and joins the
  contributor; later claims need no listing; a claim without one is refused;
- earliest root wins: a copy claimed first is moved by `correctCredit`, later claims pay the original, earlier ones
  stay; a claim carrying the earlier listing corrects in the same call; in one root, the lower leaf wins; re-posting
  a root never moves its block;
- a forged signature, a signature over another listing, a malformed one, a moved ERC-8004 identity, a listing whose
  identity field was changed after signing, a bad proof (wrong place, wrong sibling, index past the depth, root never
  posted, listing changed after proving), a malformed identity and a bad site are all refused;
- only `Listings` can call `creditEntry`;
- the legacy path: `listEntry` still lists, claims and delists, and a listing shown outranks a `listEntry` on its id;
- a fuzz test: however many listings of one content, in whatever roots and blocks, shown in whatever order, the credit
  ends on the earliest place and Settlement pays whom `Listings` credits;
- the gas figures below (`test_gas_listingBeforeAndAfter`).

`test/lean/ListingsInvariants.t.sol` drives the same in random sequences: three contributors post roots holding
listings of two contents and copies, some roots in one block; anyone shows, claims with or without a listing, and
corrects; a copier writes the ids with `listEntry`. After every step, each content is credited to the first listing
shown at the earliest place shown, Settlement's entry names the same wallet, no wallet has earned as contributor more
than the claims made while it held the credit, and every correction or `listEntry` the contract took or refused was
the right one.

The existing Settlement and invariant suites run unchanged on the new constructor.

## 4. The node: as built (spec §76.1, 1 November 2026)

The node lists by signed listing alone, and the deployment that goes with it has no `listEntry` (§7 step 4 taken at
once: a new Settlement is a new network that nodes move to together, so no node on it lists the old way).

1. **Entry ids by content.** A line names `chain::content_entry_id(contentId)` (`SignedListing::entry`), the entry
   `Listings.entryIdOf` credits. Stakes and pools stay keyed by route (`chain::route_key`).
2. **Positional roots.** `listing::positional` and `listing::climbs` build and check listing roots as
   `Listings.rootOf` does, and `Proven` carries its leaf's `index`.
3. **Reading a listing** (`listing::verify`). The signature must be the identity's key and the root posted. No chain
   entry means a listing no claim has shown yet, and it is good; an entry credited to another contributor means this
   listing is a later copy, and it is refused. The price is the contributor's `feeOf`, never under the listed price in
   the terms (`listing::price`), so a wallet that sends no `setFee` prices by its listing.
4. **Serving and receipts.** A server releases a body against a listing it holds that `verify` takes
   (`share::release`), and keeps a line for one of its own listings whether or not a claim has credited it
   (`network::accept_receipt`).
5. **The payer holds the proof.** A node keeps every listing it fetched a body under (`listing::remember`), and its
   own (`Book::of_entry`). A claim of lines on an entry no claim has credited shows that listing and its terms
   (`chain::Claim::showing`, `Listings.showAndClaim`).
6. **Who claims.** Each payee claims its own lines (R3.22): the serving node claims what it served as soon as it is
   worth its gas (`claim_owed`). The payer's claim is the backstop, once the window is half over (`backstop_due`): it
   pays a wallet that only earns and has no gas, through `showAndClaim` (§76 item 2).
7. **The reserve's roots** (R2.20, `reserve.rs`). A node run with `UNBROWSE_RESERVE_POSTER=1` takes signed leaves
   (`POST /v1/remote/reserve/leaf`) and posts one root over them each `listing.reserve_root_interval`, publishing the
   leaf lists (`GET /v1/remote/reserve/roots`). A node that knows a poster (`UNBROWSE_RESERVE_URL`, or a poster's ad
   on a devnet) sends its leaves there instead of posting, adopts the root once it is on chain, and only then spreads
   the listing. It sends the leaf, never the listing, so the poster can't copy it ahead of its root.
8. **Discovery.** Nothing reads `EntryListed`. The chain's index is `Listings.Credited` (entries some claim has
   shown), joined with the listings the node holds; listings nobody has claimed yet are found between nodes (R2.15).
9. **Delisting.** A credited entry is delisted on chain (`delistEntry`, and `relistEntry` to restore it). A listing
   no claim has credited is withdrawn by no longer serving or spreading it; signed withdrawals (step 6 of the plan)
   aren't built.

Not built: the reserve's repayment in UNB (R9.14), so the poster pays its own gas; repricing a wallet that never sets a
fee (its auto-pricing still sends `setFee`, and a new price would need a new version of the listing).

## 5. Gas, before and after

Measured by `test_gas_listingBeforeAndAfter` (`forge test --match-test test_gas_listingBeforeAndAfter -vv`) as the
gas each call used (`vm.lastCallGas`), on the test chain. These are the calls' own costs inside a test, not whole
transactions on Anvil, so compare the rows here with each other rather than with MONEY.md's figures.

| | Before (`listEntry`) | After (signed listing) |
|---|---:|---:|
| A wallet's first route | 158,911 (joins the network) | 0 |
| Each later route | 84,510 | 0 |
| A root, for any number of routes | 46,724 | 46,724 |
| A plain claim of one line | 253,533 | 253,533 |
| The first claim of a content, carrying its listing | | 381,966: 128,433 over a plain claim (a wallet already joined); 555,558 for a wallet that joins with it |
| Calldata of one listing shown | | 1,088 bytes, at most 17,408 gas |
| A claim carrying a listing already credited | | 276,689: 23,156 over a plain claim, since a later listing is skipped unchecked |
| Later claims on the content | 253,533 | 253,521 |

So listing `n` routes costs one `listEntry` each before (84,510 apiece once the wallet has joined) and one root after;
each route that is ever claimed pays about 128,000 gas plus its calldata once, at its first claim, out of what the claim
pays, and a wallet's joining moves from its first listing to its first claim. A route nobody calls costs nothing. For
automatic sharing at its daily cap (`list_per_day`, SHARING.md §4), the daily listing gas goes from that many
`listEntry`s to one `postRoot`.

## 6. Escrow, delisting and the signer, with no entry written

**Site escrow.** A site's share accrues to `escrow[domainHash]` at claim time, keyed by the entry's domain. With no
`listEntry`, the domain comes from the listing itself: its `site` field, signed by the contributor, put in canonical
form at first claim. Nothing accrues to a site before its routes are first claimed, so nothing is lost by learning the
domain then. Proving the domain's wallet and releasing its escrow (`claimEscrow`, `releaseEscrow`) are on `Domains` (R4.14), by DNSSEC only.

**Delisting.** Before its first claim a listing exists only between nodes, so it is withdrawn between nodes: a signed
withdrawal spreads like the listing, and readers drop it (R2.16; node step 6). After its first claim it has an entry,
and its contributor's `delistEntry` works on it as on any entry, as does leaving (R6.14), which takes every entry out
at once through the tenure. Settlement doesn't consult `live` when it pays a line, before or after this change: lines
already signed stay claimable. A site delisting its routes (R2.16, R4.17) is not built, before or
after.

**The signer is the contributor.** A listing names its contributor by `agentId`. On a chain with an ERC-8004
IdentityRegistry it is the identity's decimal id, and the signer must be `ownerOf(agentId)` at the time it is shown;
on a devnet without one it is the wallet itself, `0x` and 40 hex digits. The signature is checked as an EOA's or, for an
owner with code, by ERC-1271 (`SignatureChecker`). The credit and the earnings go to that wallet. A listing that names
another identity than its signer's is refused, and changing the identity after signing breaks the signature, so a
copier can list a copy only under its own identity, where it is a later listing.

## 7. Migration

Done, in one step (spec §76.1, §76.2). The Settlement of §76.1 is a new deployment with no `listEntry`, and nodes move
to it together: a node refuses a deployment made from other code (`chain::usable`), so no node on it lists the old way,
and the old deployment keeps running for peers that don't move.

1. **Contract.** The new Settlement credits every entry from the signed listing its first claim shows (§3), and a key
   the wallet granted signs no listing: only the wallet's own key does. The owner decided this on issue #184, reversing
   spec §76.2 item 1.
2. **Node, reading and claiming.** Built (§4 steps 1 to 5): unclaimed listings read, first claims through
   `showAndClaim`.
3. **Node, listing without gas.** Built (§4 steps 7 and 8): no `listEntry` or `setFee`; roots from the reserve's poster
   or the node's own; listings spread once a root holds them.
4. **Retire `listEntry`.** Done: the new deployment has none. Signed withdrawals before a first claim (§4 step 9) are
   still to come.

## 8. Risks and open points

- **The site isn't in R2.14's listing.** R2.14 lists `{ routeId, contentId, agentId, version, terms, sig }`; the site
  isn't there, but escrow needs it (R4.14) and the chain has no other source once `listEntry` goes. The node already
  signs a `site` field, and the contract reads it. The spec should name it.
- **Two roots in one block.** R2.18 orders roots by block and leaves within a root, and says nothing of two roots
  posted in one block. Listings orders them by leaf index alone, and a tie at the same index stays with whichever was
  shown first. A copier can't use this to precede an original whose node posted its root before spreading the
  listing (R2.19), but two independent contributors of one body in one block are ordered by chance.
- **A window for copies.** A copy in a later root that wins the race to the first claim is paid until someone shows
  the original; R2.18 keeps those claims paid. The contributor's own node closes the window by claiming its lines
  with its listing, or by `correctCredit` when it sees another credit at a later place (`listing::contest`, hourly).
  The credit goes final `CREDIT_FINAL_EPOCHS` after the first claim paying a use of the entry, however it is claimed. The legacy path widens it a
  little: a `listEntry` on a gossiped content id is paid by a plain `claimBatch` until a listing is shown. Both end
  when `listEntry` is retired.
- **Moved identities.** The signer is checked against the identity's owner when the listing is shown. A credit already
  recorded keeps naming the wallet it was recorded for when the identity moves.
- **Old roots.** Roots the node posted before this change are sorted-pair trees; their listings can't be credited and
  must be posted again under a positional root, at a later block. Before any of them is first claimed this costs
  nothing but the post; a copy can't have reached the chain earlier, since copies need a root too.
- **Code size.** With this change Settlement's runtime code is 23,811 bytes, 765 under EIP-170 (`forge build --sizes`,
  on main after #96). A feature bigger than that needs space made first: retiring `listEntry` (§7 step 4) or moving
  another check into a contract Settlement creates, as `Listings` does.
- **Gas at first claim.** The listing's checks and its calldata move from the contributor's listing to its first
  claim, paid out of the claim's fees by whoever claims. A first claim of a tiny fee can cost more than it pays; the
  claimer waits for enough lines, as for any claim (MONEY.md §3).
- **No `version` or `supersedes` on chain.** Each content id is its own entry; the contract doesn't read version order.
  A later version doesn't end an earlier one's entry: the contributor delists it, as today.

## 9. Phases

1. **Contract** (this change): `Listings`, `creditEntry`, `listEntry` kept; tests; this page.
2. **Node, reading and claiming** (node steps 1 to 5, 8, 9).
3. **Node, listing without gas** (steps 6 and 7); MONEY.md's listing table and SHARING.md's listing steps rewritten.
4. **Retire `listEntry`** in the next Settlement.
