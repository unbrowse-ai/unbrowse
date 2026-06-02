# Trust and Accountability

In a shared route graph, trust is a practical signal about whether a route still does what it claims, not a cryptographic guarantee.

The shipped model is reliability-oriented: routes carry success and failure behaviour, freshness, verification state, and folded-in feedback, and that composite signal moves good routes up and bad routes out of future shortlists. This is a continuous trust model in the sense the paper uses: quality is observed from real outcomes over time rather than asserted once at publish.

The Maintenance Network paper then asks how a graph should express trust and enforce accountability once it carries meaningful traffic. Its answer is deliberately narrow. Higher-trust route tiers, accountable maintainers, and challenge mechanisms are the coordination tools; optional bonding may become useful as one mechanism among others, and the FDRY asset is best understood only in that narrow role. The paper is explicit that this is a quieter accountability layer, not a token-first redesign of the product.

What does not exist today, and is described as forward-looking rather than shipped, is a full validator market, staking and slashing, or cryptographic attestation. The honest reading: practical reliability and verification ship now; the richer accountability economy is research direction, not current behaviour.

The full structure of that accountability layer is detailed in three pages: [The Maintenance Network](the-maintenance-network.md) (why access payments do not solve trust), [Route Trust Tiers](route-trust-tiers.md) (open versus higher-trust routes and the open/trusted/premium surface), and [Accountable Bonding and Where FDRY Fits](accountable-bonding.md) (bonding as a warranty not an ad slot, challenge mechanisms, and the deliberately narrow role of a coordination asset). Read those for the model; read [Where This Goes](../vision.md) for how it sequences behind the wedge.
