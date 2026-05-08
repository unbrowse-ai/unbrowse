# Proof Metadata Scope

Unbrowse ships **`commitment_only` proofs** as the proof system. Real TLSNotary integration is **not on the roadmap** — a 2026-05-05 feasibility review concluded the upstream JS path is archived (`tlsn-js`), the only published version (`alpha.12`) is incompatible with reachable public notaries (`alpha.15-pre`), and a Rust-sidecar alternative is investment we won't make without concrete user demand. If that demand surfaces, the parked design doc at `tlsnotary_expand.md` and today's spike findings document exactly which version to match and why the JS path is dead.

## What is implemented

- Endpoint descriptors can carry `zk_proof` metadata.
- `commitment_only` records a SHA-256 commitment to a captured response body, signed locally by the publisher.
- The backend validates proof metadata shape and rejects malformed proof objects with 422.
- The four-state `proof_status` is enforced everywhere inside Unbrowse: `proven` (reserved, never set today), `client_commitment` (yellow — what `commitment_only` produces), `unverified_proof` (yellow — proof present but couldn't verify), `no_proof` (gray).
- Frontend renders the four states with distinct colors. `--require-proof` filters resolve shortlists to `proof_status: "proven"` only (today: returns empty, by design).
- `summarizeSkillProofs.verified_proofs` deliberately excludes `commitment_only` from the verified count, so the marketplace's "Verified" badge stays dark until real provenance ships.

## What is not implemented and not planned

- Real TLSNotary (notary server, MPC handshake, WASM verifier). See above.
- Reclaim Protocol implementation.
- Selective disclosure; current commitments are whole-response hashes.
- `unbrowse proof verify <skill_id>` standalone CLI.
- Higher payouts for proven endpoints.
- Stale proof decay.
- Public ZK marketing.

## Security boundary

**`commitment_only` is tamper-evident metadata, not cryptographic provenance.** A SHA-256 the publisher computed over the publisher's own captured bytes proves nothing about origin — anyone can fabricate a response and hash the fabrication. The system is useful for detecting after-the-fact tampering (e.g. someone editing the marketplace KV) and for cross-checking re-execution against the original capture. It is **not** evidence that the response came from a claimed origin over TLS.

## Trust-channel boundary (for downstream consumers)

If exporting `SkillManifest` to a foreign distribution channel (skills.sh, third-party agent registries, raw markdown), strip `endpoints[].zk_proof`, `proof_summary`, and any computed `proof_status` from the rendered output. The four-state proof vocabulary is enforced only inside Unbrowse — outside it, the fields read as trust claims they aren't.
