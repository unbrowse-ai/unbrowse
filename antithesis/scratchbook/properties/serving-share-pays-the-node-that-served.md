# serving-share-pays-the-node-that-served

**Retired (route coins, 11 November 2026):** a serving node is paid no share of a line (`fees.server` = 0, the 65 / 30 / 5 split). The workload now checks `only-a-claims-contributors-are-owed`: the fetch owes a claim's route share only to the credited contributor of an entry the claim paid. What follows is the record of the earlier property.

**Focus:** 6 Security Boundaries (who is paid) and 1 Data Integrity. **Confidence:** high that the share burns on the default path; the intent needs the owner. **Status:** confirmed against the claimed guarantee (code + probe).

## Property

When a passed line names the node that released the body as its server, that node is credited the 5% serving share. The share is burned only when the line names no server (a failed use, or no admitted server).

## Claimed guarantee

- protocol.md R4.3 "The serving share h(p) of a passed line is paid to the node the line names as its server (R3.14), often the contributor."
- R7.3 "A host or seeder needs **no bond and no record** to serve ... It is paid as a server (R7.6)."
- R7.6 "The node that served a passed line is paid 5% of its fee."
- Node comment `share.rs:8-9` "The use's receipt line names the node that served the body as its holder, which is how serving is paid (R7.6)."

## Code path

- Caller names the server: `unbrowse-node/app/src/share.rs:311-318` (`server = v.contributor` when the peer is one of the contributor's nodes, else the admitted identity's wallet). `api.rs:788,846` passes it to `chain::add_network_receipt` (`chain.rs:1179-1181`), which fixes `holders = [server]`.
- Contract pays only on-chain holders: `LeanSettlement.sol:973-997` `_payHolders` skips any `h` with `!holding[h][routeId]` (`:980`); unpaid pool goes to BURN (`:963-966`). The doc comment at `:972` ("the remainder stays with the caller's contributor share") contradicts the code, which burns it.
- What sets `holding`: only `holdRoute` (`:774-778`). The node sends it from `chain::hold` (`chain.rs:1000-1008`, the owner's `hold_route` command, `main.rs:628-629,1293`) and `chain::hold_entry` (`chain.rs:1018-1026`), called only by `peers::hold_tick` (`peers.rs:437-512`) when `settings.hold_routes` is true. Default `hold_routes: false` (`store.rs:464`).
- `hold_tick` holding does not make a node a body server: `share::held` (`share.rs:123-134`) serves only its own listed bodies and bodies it fetched. A node that only "holds" never serves; a node that seeds never holds unless the owner also turns holding on. The two meanings of "hold" never meet (sut-analysis §9).
- Contributors are asked first (`share.rs:264-275`), so the usual server is the contributor itself, who by default does not hold its own entry either.

## Discriminating evidence

Competing explanation: "the five-node test shows the seeder is paid." It doesn't: `share.rs:755` asserts the line *names* the seeder; nothing asserts a payout.

`scratchpad/money-probe/test/lean/MoneyProbe.t.sol::test_probe_unheldServerShareBurns`: a 10-USDC line naming `holder3` (served, never called `holdRoute`): `named server earned: 0`, `burned: 1e18` (5% burn + 5% serving share). Existing repo test `test_claim_listedNonHoldersAndDuplicatesIgnored` (`Settlement.t.sol:596-610`) shows the same rule.

## Failure scenario

Default settings, three nodes: node-1 lists, node-2 fetches and seeds, node-3 fetches from node-2 (or node-1). Every passed line names a server; every serving share burns. Servers are never paid for serving, the economic reason to seed disappears, and the burn is twice the 5% the economy paper describes.

## Antithesis angle

The interesting state is "a non-contributor seeder served a body that passed". Antithesis's fault injection (kill node-1, partition node-1 from node-3) forces callers to fetch from the seeder, which is exactly when R7.3 matters. Toggling `hold_routes` on node-2 explores both branches.

## Instrumentation (all missing)

- Workload `Always("a passed line naming a server credits that server the serving share")`: for each `Claimed` event, decode the line's holders from the claimBatch calldata; for each named server assert `vestingOf+vestedOf` (or bond filled, if withheld) rose by `amount*5/100/len` and BURN by the burn share only. Missing.
- Workload `Sometimes("a seeder that is not the contributor serves a body whose line passes")`: from node activity logs (`share.rs:154-165` "Served a route's body") on node-2 matched to a passed line. Missing.
- SUT-side `Reachable("a line names a server that holds nothing on chain")` in `running_voucher`/`push_receipt` (one `holding()` read). Missing.

## Open questions

- Is a hold record meant to be required (contract comment `:772` "Only a holder of a route shares its serving 5% (R4.3)"), or is R7.3 the rule? The answer decides whether the defect is in the contract (drop the `holding` check, which then trusts the payer's choice of server) or in the node (seeding must `holdRoute`). Stage-1 asked the same.
- If the `holding` check goes, nothing stops a payer naming itself or a friend as server. Is that acceptable because the payer already chooses the line? This changes whether the invariant should also say "the named server is the peer that released the body".
