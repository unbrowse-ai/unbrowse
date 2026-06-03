# Trust and Accountability

In a shared route graph, trust is a practical signal about whether a route still does what it claims, not a cryptographic guarantee.

The shipped model is reliability-oriented: routes carry success and failure behaviour, freshness, verification state, and folded-in feedback, and that composite signal moves good routes up and bad routes out of future shortlists. This is a continuous trust model in the sense the paper uses: quality is observed from real outcomes over time rather than asserted once at publish.

A maintained graph then asks how it should express trust and enforce accountability once it carries meaningful traffic. The answer is deliberately narrow: higher-trust route tiers, accountable maintainers, and challenge mechanisms are the coordination tools. This is a quieter accountability layer, not a redesign of the product.

What does not exist today, and is described as forward-looking rather than shipped, is a full validator market or cryptographic attestation. The honest reading: practical reliability and verification ship now; the richer accountability layer is research direction, not current behaviour. Throughout, discovery stays free — an agent only pays when it executes a paid route, settled over x402.

Read [Where This Goes](../vision.md) for how this accountability layer sequences behind the wedge.
