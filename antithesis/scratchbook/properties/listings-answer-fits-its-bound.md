# listings-answer-fits-its-bound

**Focus:** 4 Protocol Contracts. **Confidence:** high (confirmed by probe).

## Claim being tested

`node.rs:51-55`: listings taken from one provider's answer are at most `MAX_LISTINGS_PER_SOURCE` (32), and "the most bytes a listings answer ... may hold" is `MAX_ANSWER_BYTES` (256 KiB). `peers.rs:103-105`: `MAX_SIGNED_BYTES` (7 KiB per signed listing) is chosen so "a provider's answer carries many, within the network's bound on an answer". The reader-side cap of 32 gives the impression that an over-full answer is truncated, not lost.

## Code paths

- Writer: `ServedListings::site` (`peers.rs:141-165`) returns **every** own listing for the site plus every held one when `hold_routes` is on, with no count or byte cap on the answer. `node.rs:791` sends it as is.
- Codec: `request_response::json` (libp2p-request-response 0.30.0, `src/json.rs`): `read_response` does `io.take(response_size_maximum).read_to_end` and then `serde_json::from_slice`. `write_response` writes everything. An answer over 256 KiB is cut mid-JSON, fails to parse, and becomes an `OutboundFailure` at the asker.
- Reader: `Net::find` (`node.rs:382-386`) skips a source whose fetch errored (`let Ok(listings) = answer else { continue }`), so that identity is not counted in `sources` and adds nothing to `checked`.
- Limits involved: 32 × 7 KiB = 224 KiB fits; 37 listings at the 7 KiB cap do not. A holder may hold up to `max_held(storage_gb)` routes (62,500 at 4 GB, `peers.rs:426-429`), all served for their site.

## Probe evidence (`probe_oversized_listings_answer`)

Provider A answers 36 listings of about 6 KiB (about 220 KiB). Provider B answers 48 (about 295 KiB). A seeker looks up the site 3 times.

- Each time: **32 listings, sources `["0xa"]`**. B is absent from `sources` entirely. Had B's answer been truncated to 32 on the reader side, there would be 64 listings and 2 sources.

## Failure scenario in Antithesis

The workload lists many routes for the fixture site from one contributor, or turns on holding on node-2 for a site with many entries. No fault is needed to violate it. Faults matter for the interaction: with one large provider and one partitioned, the lookup has zero sources.

## Invariant and assertions (all missing)

- SUT-side at `node.rs:791` (before `send_response`): `Always(serde_json::to_vec(&answer).len() <= MAX_ANSWER_BYTES)`. Message: "a listings answer a node sends fits the bound its asker reads".
- Workload: for every lookup, `Always(found.sources ⊇ identities that are reachable, admitted and provide the site)` after a quiet period, which also catches the silent drop.
- SUT-side at `node.rs:1045-1047` (listings `OutboundFailure`): `Unreachable("a listings answer failed to decode")` once the writer bounds its answer. Under the current code it is the direct signal.

`Always` fits the writer-side check: it is a pure protocol bound that must hold on every send.

## Why it matters

A contributor with many routes on one site, or a holder doing exactly what the serving role asks, becomes invisible as a source for that site, and lookups lose their second identity. The failure is silent: the asker sees a decode error, and the provider sees a successful send. The fix class is general (bound the answer at the writer, by bytes, keeping the newest or best), with no site or host names involved.

## Open questions

- Which listings should a writer keep when it has more than fit: own before held (current order), newest first, or by fee? This shapes the fix, not the property.
- Should `MAX_LISTINGS_PER_SOURCE` and `MAX_ANSWER_BYTES` be enforced together at the writer, so that 32 × `MAX_SIGNED_BYTES` is the explicit budget?
