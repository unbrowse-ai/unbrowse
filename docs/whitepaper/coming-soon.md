# Coming Soon

This page lists the forward-looking parts of the whitepaper that are not yet present in the codebase, or not yet present in the full form described in the paper.

It does not cover the narrower payment path that already ships today: x402 / HTTP 402 payment requirements, Solana/Base USDC payment terms, wallet-linked payment metadata, and current payout routing.

## Route Economy

The paper’s richer route economy is still `coming soon`:

- fee ceilings tied to rediscovery cost
- dynamic route pricing based on confidence, freshness, and demand
- multi-party fee splitting per execution
- paper-style attribution across contributors and maintainers

## Contributor Economics

The paper’s fuller contributor economy is also `coming soon`:

- maintainer payout lanes beyond the current winner-takes-route wallet
- treasury or reserve accounting
- delta-based attribution for route improvements
- anti-Sybil economic attribution

## Site-Owner Compensation

The paper’s opt-in site-owner compensation model is `coming soon`:

- domain registration by site owners
- opt-in payment routing to site owners
- website-as-usage-priced-endpoint economics

## Advanced Trust Infrastructure

The practical reliability model ships today, but these stronger trust primitives are `coming soon`:

- validator attestations
- validator staking and slashing
- signed trust evidence beyond current feedback and verification fields
- cryptographic proof of route verification
- TEE-backed verification attestation

## Zero-Knowledge Fill Authorization

Unbrowse op receipts are wallet-signed today: an Ed25519 signature over
`(pointer, nonce, url, selector, iat)` proves your wallet authorized the act.
The pointer-only invariant — no secret value ever crosses the wire — already
holds. This ships in the v7 preview.

Still `coming soon` is the **zero-knowledge** strengthening of the authorization
claim: a proof that an authorized wallet signed an authorized pointer **without
revealing which wallet or which pointer**, behind the same receipt and audit-log
interface. It is a substitution of the signature primitive, not a new surface —
callers write against one interface across both stages.

Read this as product direction. The honest scope: pointer-only plus
wallet-signed audit receipts are the shipped baseline; the SNARK-backed proof is
a later rollout behind the same interface, and the value-protection guarantee
(pointer-only, local dereference, in-memory zeroing) does not depend on it.

## Packaging and Distribution Model

The paper’s richer route package story is `coming soon`:

- per-route installable skill bundles in the paper’s packaging form
- generated `api.ts` client distribution as part of every shared route package
- paper-style `auth.json` package artifact flow

## How To Read These Sections

When the whitepaper talks about these systems, read them as:

- product direction
- research framing
- architectural intent

Do not read them as “already available in the current release” unless the docs explicitly move them out of `coming soon`.

The shipped payment lane today is narrower: x402-gated search/execution, HTTP 402 payment requirements, Solana/Base USDC terms, wallet-linked payment metadata, transaction surfaces, and current payout routing. This page is about the remaining paper-era expansion beyond that shipped baseline.
