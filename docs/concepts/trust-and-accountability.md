# Trust and Accountability

In a shared route graph, trust is a practical signal about whether a route still does what it claims, not a cryptographic guarantee.

The shipped model is reliability-oriented: routes carry success and failure behaviour, freshness, verification state, and folded-in feedback, and that composite signal moves good routes up and bad routes out of future shortlists. This is a continuous trust model in the sense the paper uses: quality is observed from real outcomes over time rather than asserted once at publish.

A maintained graph then asks how it should express trust and enforce accountability once it carries meaningful traffic. The answer is deliberately narrow: higher-trust route tiers, accountable maintainers, and challenge mechanisms are the coordination tools. This is a quieter accountability layer, not a redesign of the product.

What does not exist today, and is described as forward-looking rather than shipped, is a full validator market or cryptographic attestation. The honest reading: practical reliability and verification ship now; the richer accountability layer is research direction, not current behaviour. Throughout, discovery stays free — an agent only pays when it executes a paid route, settled over x402.

## Settlement vs accountability

Usage is **settled in USDC** — a paid `execute` clears in stable value over x402, so an
agent (or the human behind it) pays a predictable price. Accountability is carried by the
[contract platform](./contract-platform.md) itself: every route claim is signed, typed,
and checkable — not by a stake token.

## How /contract carries it

A maintained route is not a free externality — under the [contract platform](./contract-platform.md)
it is a **signed, checkable asset**:

- **/contract** turns each route into a typed, wallet-signed claim with a verifiable
  freshness proof. A maintainer standing behind a route makes a checkable promise:
  *this still resolves, and its shape still matches.* A proof that fails to reproduce
  is challengeable — the signature is what gives a trust tier teeth.

Reliability and USDC settlement ship today; any further bonded-proof-of-indexing
accountability economy is a research direction, not current behaviour.

Read [Where This Goes](../vision.md) for how this accountability layer sequences behind the wedge.
