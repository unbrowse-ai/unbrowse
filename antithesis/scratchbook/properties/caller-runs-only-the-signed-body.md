# caller-runs-only-the-signed-body

**Focus:** 6 Security Boundaries. **Confidence:** medium (holds by code reading; needs a lying provider to test). **Status:** claimed guarantee to test; no defect found.

## Property

A caller runs, keeps, seeds and pays for another contributor's body only when its bytes hash to the content id in a listing that (a) the entry's on-chain contributor's identity key signed under this deployment's domain, (b) sits under a posted root, and (c) names a live entry for the same site. A provider that serves other bytes is never paid and is set aside.

## Claimed guarantee

- protocol.md R3.9, R7.19 ("a body is used and paid only when it matches the signed content id"), R7.20 (set aside on a doubling schedule), R2.15 (listing checks); AGENTS.md "a listing is checked before an agent sees it".

## Code path

- `listing::verify` (`listing.rs:196-215`): signer == `identity_key(agent_id)` (ERC-8004 `ownerOf`, or the wallet on a devnet, `:178-183`); `leaf == listing.leaf(domain)` and `proves(root, leaf, proof)` (`:148-160`); `rootBlock(root) != 0`; entry contributor == signer, entry live, `domain_hash == hash(site)`.
- Domain separation: the listing, the running voucher and `BodyFetch` are distinct EIP-712 types under one domain (`listing.rs:27-31`, `chain.rs:1282-1287`, `network.rs:173-187`).
- `share::fetch` takes `content_id` from the verified listing only (`share.rs:256-257`), checks bytes with `recipe::verify_body` (`recipe.rs:390-400`: hash, canonical form, `check`), and on mismatch sets the provider aside and moves on (`share.rs:298-305`) before any save or line.
- Cached listings are re-verified before use (`share.rs:221-226`, `api.rs:464-469`).
- Note: `postRoot` is permissionless and free (`LeanSettlement.sol:757-763`), so condition (b) proves only timing, not authorship; the signature carries authorship.

## Antithesis angle

Needs a byzantine provider: a raw libp2p node (pattern of `crates/net/tests/bodies.rs::a_provider_that_sends_more_than_a_body_may_hold_is_cut_off`) registered in the fake/stand-in registry that answers with (1) different bytes, (2) an older version's body, (3) a listing signed by a non-owner key, (4) a listing for another site's entry. Combine with node restarts (the provider set-asides are memory-only, `share.rs:13-14`) to check a restarted caller re-checks rather than trusts.

## Instrumentation (all missing)

- SUT-side `Always("a fetched body hashes to its signed listing's content id")` right before `recipe::save_body` in `share::fetch`. Missing.
- SUT-side `Always("a listing used for a call is signed by its entry's contributor")` in `call_entry` after `listing_of`. Missing.
- SUT-side `Sometimes("a provider served a body that isn't the listed one")` at `share.rs:302`, so the lying-provider path is known to be explored. Missing.

## Open questions

- An older, still-signed version of an entry passes every check (versions never change, R2.6). Should a caller refuse a version older than the newest it has seen (`Share::saw` keeps the newest only in memory)? If yes, the property gains a "newest version" clause.
