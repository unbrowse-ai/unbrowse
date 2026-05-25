# Unbrowse Primitives (public)

This folder is the public-facing inventory of the primitives Unbrowse runs on. Every file here describes one mechanism and the rules around it. If a mechanism appears here, it is in the shipped product. If it does not, it is not.

The intent is auditable transparency. Anyone reading this folder can verify, without running the binary, what Unbrowse does and what it never does.

## What lives here

1. [pointer-not-payload](./01-pointer-not-payload.md) — the architectural law. Capability lives at one address, payload never travels with it.
2. [residential-proxy-fallback](./02-residential-proxy-fallback.md) — when a site rejects datacenter traffic, requests escalate through a residential proxy. Opt-in by env, never on by default.
3. [interstitial-shortcut](./03-interstitial-shortcut.md) — when a site serves a JS challenge as a direct document, we attempt a fingerprinted HTTP fetch before falling back to a real browser.
4. [x402-and-faremeter](./04-x402-and-faremeter.md) — payment for paid endpoints is gated at the HTTP layer via x402. Faremeter is the settlement layer; payment providers are pluggable.
5. [user-response-never-contains](./05-user-response-never-contains.md) — the explicit list of fields that never appear in any user-facing response, with the audit gate that enforces it.
6. [domain-opt-out](./06-domain-opt-out.md) — how a site verifies ownership of a domain and triggers removal from our index.
7. [fair-split-and-claim](./07-fair-split-and-claim.md) — paid resolves split among indexer, domain owner, and Unbrowse; unclaimed domain shares accrue in a global holding wallet; Privy-tied claim transfers the balance.

## What this folder is not

This is not the developer onboarding (`README.md`), the technical architecture (`docs/architecture.md`), or the release notes (`CHANGELOG.md`). Those describe how the code is laid out and what shipped when. This folder describes what the code does at the level a non-developer auditor needs.

## Reading order

If you have ten minutes: read `01-pointer-not-payload.md` and `05-user-response-never-contains.md`. Those two are the bedrock.

If you have an hour: read all of them in order. The numbered files compose into the full picture.

## How this stays honest

Every file in this folder is reflected to the public repository on every release. A CI gate (`scripts/check-primitives-doc-public.sh`) fails the build when:

- a file under `docs/public/primitives/` references an internal substrate identifier
- a primitive named here is not present in the codebase under the named path
- a primitive present in the codebase under a path that this folder claims to describe is missing from the inventory

The folder is therefore not aspirational. If a file says Unbrowse does X, the gate has verified X is in the shipped code.
