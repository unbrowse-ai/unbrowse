# Verification and Proofs

Unbrowse is deliberately honest about what its proofs do and do not establish today. The short version: proofs today are local commitments, not third-party-verifiable attestations, and the system refuses to claim otherwise.

## What ships today

Endpoint descriptors can carry proof metadata. The shipped proof type is a commitment: a SHA-256 commitment to a captured response body, signed locally by the publisher. The backend validates proof shape and rejects malformed proof objects.

Trust is exposed as a four-state channel, not a binary badge:

* **proven** reserved, never set today, it waits for real provenance
* **client commitment** a local commitment exists (shown as a cautious state, not a green check)
* **unverified proof** a proof is present but could not be verified
* **no proof** nothing attached

The marketplace's verified count deliberately excludes local commitments, so the strong signal stays dark until something stronger than self-attestation ships. A proof-required filter returns empty today, by design. This is the system telling the truth rather than lighting a badge it has not earned.

## What is not shipped, and not overclaimed

Third-party notarised proofs (MPC notary handshakes, WASM verifiers), selective disclosure, and full cryptographic route-verification are research direction, not current behaviour. Stronger provenance is part of an ongoing security and verification effort; specifics will be detailed in a forthcoming whitepaper. It is described here as direction, and the docs will not claim it as shipped until it is.

## The security work behind this

The proof-metadata model, the four-state trust channel, the trust-channel boundary for downstream consumers, and the discipline of not lighting a Verified badge until provenance is real are part of security and verification work led by Goh Ee Sheng. The conservative posture is the point: a trust system that overstates itself is worse than one that is honest about its current limits.

For how this connects to economic accountability, see [Trust and Accountability](trust-and-accountability.md).
