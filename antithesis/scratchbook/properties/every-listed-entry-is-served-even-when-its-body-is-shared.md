---
sut_path: <checkout>/harness
commit: e96f00c1e97085c40dd1455335a4d75bd7fb5c09
updated: 2026-10-30
---

# every-listed-entry-is-served-even-when-its-body-is-shared

**Found by the harness's local run on the deck, not by the research pass.**

## Property

Every live entry a node lists is one it serves: a caller paying for that entry's body gets it, whatever other entry
the node also lists.

## What the deck showed (e96f00c1)

The first fixture had two routes that make the same call, `POST /api/cart?q=` with the caller's session: one listed
as "Add an item to the cart", one as "Look up items". Their bodies are byte-identical, so their content ids are equal.
A caller fetching the second entry failed every time: activity "No node served the body of entry df92d7bbb2…", note
"a provider refused: the voucher pays for another entry". The line was a failed use, and the entry went toward dark.

## Mechanism (code reading)

`share::held` (`unbrowse-node/app/src/share.rs`) finds the entry a content id is served under with the first listing
in the book whose `content_id` matches, so a body two entries share is only ever served as the first one. `release`
then checks the voucher against that entry (`network.rs`: "the voucher pays for another entry") and refuses the
other entry's caller.

## Antithesis angle

A fixture with two entries sharing one body, and `Always(served)` on a paid fetch of either from the contributor
while it is up. The harness's fixture now gives the read-worded write route its own call (`POST /api/lookup`), so this
case isn't driven by default.

## Open questions

- Should a body served under several entries be looked up by (content id, entry) from the voucher, or should
  listing a second entry with an existing body be refused?

## Fixed (branch `harness-defects`, from ddb3b462)

`share::held` now returns every entry a body serves (each own listing version that names it, each fetched entry
that keeps it), and `release` takes the entry from the voucher: it must be one of those, or (for a seeder) an entry
whose signed listing this node read and checked names the same body (`seen_under`). Live, fee and, for an own
entry, contributor are checked against that entry. A voucher for an entry whose listing names another body is
refused ("the voucher pays for an entry this node doesn't serve that body under"). `provide_all` announces each body
once; `drop_cached` and the delist path keep a body and its record while another entry still serves it.

Test: `share::tests::a_body_listed_twice_is_one_entry_and_served_under_it` (Anvil). Before the fix it failed with
"route-lookup: the voucher pays for another entry". Since Settlement v2 entries are bodies' (`Listings.entryIdOf`), so
two listings of one body are one entry, and the test checks that instead (renamed from
`every_listed_entry_is_served_even_when_its_body_is_shared`, 1 November 2026). The fixture's `route-lookup` is a duplicate body of `route-cart`
again, and `parallel_driver_call` calls it (`call_lookup`), with `Sometimes` "an entry whose body another entry also
lists was paid for and fetched".
