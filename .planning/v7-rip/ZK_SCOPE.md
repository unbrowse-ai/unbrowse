# ZK x402-wallet scope (v7)

**Status:** scoping doc; no code in this PR.
**Owner:** Lewis (designate one half-time engineer for v7.x circuit work).
**Directive:** *"we do not LOG passwords or cookies or any values of any form but we sign with ZK via the x402 wallet bound to the unbrowse cli binary"*.
**Chosen primitive:** real Groth16/Halo2 SNARK over a pointer-only witness — Lewis explicitly rejected (a) reuse of covenant ed25519 and (c) x402 EIP-712 in favor of (b).

This document is the truth about *what that costs and how to ship it*. Real client-side SNARKs are months of work, and the scope below treats them as such.

---

## The proof statement (predicate)

The fill operation must prove three things in one shot, without revealing the wallet, the cleartext value, or the secret key:

```
Public inputs:
  P  = pointer_commitment       // poseidon(pointer_uri) — public binding
  N  = nonce_commitment         // poseidon(nonce ‖ url ‖ selector_or_field_id)
  R  = authorized_pointers_root // Merkle root of pointers this wallet may dereference
  C  = wallet_commitment        // poseidon(wallet_pubkey)        — the unbrowse-bound x402 wallet
  S  = sig_message_hash         // poseidon(P ‖ N ‖ C)

Witness (private):
  sk         // ed25519 / EdDSA secret key for the bound wallet
  pk         // matching pubkey
  pointer    // raw pointer URI bytes (op://… or keychain://…)
  nonce      // 32-byte random
  merkle_path // membership proof of poseidon(pointer) in R

Predicate (∃ witness s.t.):
  1.  C == poseidon(pk)
  2.  N == poseidon(nonce ‖ url ‖ selector_or_field_id)        // domain-bound
  3.  P == poseidon(pointer)
  4.  VerifyMerklePath(poseidon(pointer), merkle_path, R) == 1
  5.  EdDSAVerify(pk, sig_msg = S, sig) == 1                    // pk authorized this fill
```

What this proves to the verifier:
- A wallet (unrevealed) committed to `C` is one of the wallets authorized over `R`.
- That wallet signed an authorization over `(pointer, nonce, url, selector)`.
- The pointer is in the authorized set, **without revealing which pointer**.
- The actual cleartext value (password, cookie, OTP) is *never* an input to the circuit; it is dereferenced **only on the client, after the proof verifies**, and only inside the kuri-free fill runtime.

**Constraint count (order-of-magnitude):** EdDSA-Ed25519 in-circuit is the dominant cost (~2 M R1CS constraints in a naive implementation; ~250 k with a JubJub/Baby-Jubjub variant and Poseidon-friendly curves). Merkle path (depth 20, Poseidon hashes): ~40 k. Domain-binding hashes: ~3 k. Total realistic target: **~300 k constraints** using EdDSA-on-Baby-Jubjub + Poseidon. A naive Ed25519-in-Ristretto translation blows to 2 M+ and is not viable client-side.

**Implication:** the "x402 wallet bound to the unbrowse cli" must, for ZK purposes, be an **EdDSA-on-Baby-Jubjub** keypair (or its sibling JubJub for Halo2). The existing Solana Ed25519-curve wallet does **not** sign in-circuit cheaply; we will need to bind a *companion* SNARK-friendly key to the same identity (one-time attestation that ties the SNARK-friendly pk to the on-chain x402 pubkey).

---

## Proof system recommendation (trade matrix)

| | **Groth16** | **Halo2 (IPA)** | **PLONK (universal)** | **Nova / folding** |
|---|---|---|---|---|
| Trusted setup | per-circuit ceremony | none | universal SRS (reusable) | none |
| Proof size | ~200 bytes (tiny) | ~2–4 KB | ~400–600 bytes (KZG) | ~10–20 KB |
| Verify time | <5 ms | ~20 ms | <10 ms | ~50 ms |
| Prover time @ 300 k cs (laptop) | 1–4 s | 4–10 s | 2–6 s | not mature for one-shot |
| Wasm browser prover | yes (snarkjs, arkworks-rs wasm) | yes (halo2 + wasm32 — slow) | yes (plonky2 / snarkjs) | experimental |
| Tooling maturity | very mature | mature, evolving | mature | early |
| Audit ecosystem | best | good | good | poor |

**Recommendation: Groth16.**

Reasons:
1. Smallest proofs on the wire (~200 bytes) — the audit log row stays cheap to store in KV/D1.
2. Fastest verifier — backend audit endpoint can verify thousands/sec on a Worker.
3. Best prover wall-clock at our constraint count.
4. Mature wasm toolchain (snarkjs verifyer + arkworks-rs prover).
5. The per-circuit trusted setup cost is a one-time CI ceremony, not an ongoing tax.

Cost we accept: per-circuit ceremony. We will run **one** ceremony for the v7.x fill circuit; if the circuit changes (e.g., Merkle depth bumps from 20 → 24), we rerun.

Halo2 is the credible second choice; we keep it as the **fallback** if the circuit ends up changing often during the v7.x prototyping phase, since no ceremony per change.

---

## Toolchain recommendation

CLI is bun/node TypeScript. The prover must run on the user's laptop.

Recommend: **arkworks-rs (Rust) compiled to wasm, called from the bun CLI via a thin wasm-bindgen wrapper packaged as a native dependency in `packages/zk-fill/`.**

- **Prover**: `arkworks-rs/groth16` + `arkworks-rs/r1cs-std` + `arkworks-rs/crypto-primitives` (EdDSA gadget, Poseidon gadget, Merkle gadget — all in tree).
- **Circuit DSL**: write the R1CS in Rust against arkworks. No DSL pidgin (circom) — circom + snarkjs is a viable shortcut for v7.x **prototype** because of fast iteration, but arkworks is the long-term home.
- **Wasm boundary**: prover compiled with `--target wasm32-unknown-unknown`; called from bun via `import init, { prove_fill } from "@unbrowse/zk-fill-wasm"`. Witness assembly and public-input hashing happen in TS; the wasm prover takes a packed witness buffer and returns proof bytes + public inputs.
- **Verifier**: also compiled to wasm so the same binary can verify locally (test path) and so the backend Worker can verify without a separate runtime. Cloudflare Workers run wasm natively.

Alternative considered: **gnark (Go)**. Faster compile, simpler R1CS DSL, but adds a Go toolchain to the unbrowse build; we'd ship a Go binary alongside the CLI. Rejected for build-graph hygiene.

Alternative considered: **circom + snarkjs**. Pure JS, no FFI. But the prover is slow (10× arkworks at our size), and snarkjs is in maintenance mode. Acceptable for **v7.x.0 prototype only** while we wire the surrounding pipeline; replace with arkworks in v7.x.1.

---

## Trusted setup decision

**Per-circuit Groth16 ceremony**, executed once when the v7.x fill circuit's R1CS is frozen.

Procedure:
1. Use the **Aztec / Perpetual Powers of Tau** universal Phase 1 transcript (already done by the community; no per-project Phase 1 cost).
2. Run Phase 2 (circuit-specific) as a 3–5 contributor ceremony among the unbrowse team. Tooling: `snarkjs` Phase 2 commands; publish all contribution hashes + verification transcripts to the unbrowse repo.
3. Ship the resulting **verifier key** in the unbrowse backend Worker bundle (a few KB).
4. Ship the **proving key** to clients per the next section.

If we change the circuit, we re-run Phase 2 only. Phase 1 is reused forever.

---

## Proving key shipping

PK for a 300 k-constraint Groth16 circuit is ~30–80 MB. Options:

| Option | Pros | Cons |
|---|---|---|
| Bundle in npm tarball | offline, deterministic, signed by npm | adds 50 MB to `npm i unbrowse`; brutal for CI users |
| CDN-download on first use | small CLI install, fast subsequent runs | network dependency at first fill; integrity check needed |
| Embed in binary | one artifact | same size cost, harder to rotate |

**Recommendation: CDN download on first use, content-addressed by sha256, cached at `~/.unbrowse/zk-keys/<circuit-id>.pk`, integrity-checked against a hash baked into the CLI binary.**

- CDN URL: `https://cdn.unbrowse.ai/zk/v7.x.0/fill.pk` (or R2 / Cloudflare Pages asset).
- The CLI binary holds the sha256 of the PK and refuses to load a tampered one.
- First-fill UX: "downloading proving key (one-time, 40 MB)…"; subsequent fills are zero network.
- Circuit changes ⇒ new circuit-id ⇒ new PK URL ⇒ old cached PK becomes inert.

---

## x402 wallet binding to unbrowse binary

The directive: *"x402 wallet bound to the unbrowse cli binary"*. The binding must be (a) provable on chain, (b) usable in the SNARK predicate, and (c) bootstrap-able without a manual key paste.

Two keys, one identity:
1. **x402 spend key** (Ed25519 over the curve x402 uses today — see `backend/src/services/sponsor-flex.ts` and Solana kit). This is what pays USDC.
2. **ZK signing key** (EdDSA on Baby-Jubjub) — the SNARK-friendly key used in the fill circuit predicate.

Bootstrap (first run of `unbrowse setup`):
1. CLI generates both keypairs locally.
2. Stores both in **OS keychain** via the existing `src/vault/index.ts` keytar wrapper (fall back to encrypted file at `~/.unbrowse/vault.enc`).
3. CLI requests an **attestation** from the unbrowse backend (`POST /v1/wallet/attest`): the request includes the x402 pubkey, the ZK pubkey, and a signature by each over the other (cross-binding).
4. Backend verifies both signatures and emits an **attestation receipt**: an Ed25519 signature by the unbrowse team master key over `(x402_pubkey, zk_pubkey, install_id, timestamp)`.
5. The attestation receipt is the canonical "this wallet pair was issued by the unbrowse install at time T" claim. It is referenced (by hash) in every published fill proof so the verifier can trace the ZK pubkey back to a real install.

The unbrowse team master pubkey lives next to the existing `LEWIS_DEPLOYER_PUBKEY_v1` substrate (`backend/src/lib/attestation.ts`). Reuse that path; do not invent a parallel key hierarchy.

Wallet rotation: same flow with a `superseded_by` link in the attestation chain (Heb 7:18-19 — prior commandment annulled, new one stands).

---

## Verifier surface (what checks the proof, where)

Two verifier surfaces, with very different realism:

### v7.x.0 — backend audit log (realistic, ships)

- New route: `POST /v1/audit/fill-proof` (Cloudflare Worker, gated like other unbrowse routes).
- Request body: `{ proof, public_inputs: { pointer_commitment, nonce_commitment, authorized_pointers_root, wallet_commitment, sig_message_hash }, attestation_receipt_hash, intent_url_hash }`.
- Worker loads the Groth16 verifier (wasm) and the verification key, runs `verify(proof, public_inputs)`, **persists the proof + public inputs + receipt hash** to the audit log (D1 row), and never sees pointer cleartext or the value.
- The audit log row is the on-record artifact for "unbrowse filled a value here, signed by a wallet authorized over that pointer set, at this time, without revealing what the value was."
- Read surface: `GET /v1/audit/fill-proof/:id` returns the row (admin-gated; public hash chain for auditability).

### v7.x.1+ — remote site asks for the proof (aspirational, not v7)

The site we're filling against would need to know to demand the proof and to verify it. That requires:
- A standard format (we'd publish a draft RFC).
- Site-side verifier integration (none today).
- A reason for the site to want it.

**Honest scope cut:** v7 ships only the backend-audit verifier. The remote-site verifier is a Lewis-pitched standard for v8+ and is **not** committed.

---

## Nonce + replay protection

Every fill proof commits to:
- `nonce` — 32 random bytes generated client-side per fill.
- `url` — full URL bytes (or a canonical SHA256 of them) of the page being filled.
- `selector_or_field_id` — DOM-side: the CSS / ARIA selector path. API-side: the JSON pointer or header name.
- `timestamp` — included in `attestation_receipt_hash` indirectly, plus a separate `iat` public input bound to a 5-minute window enforced by the audit endpoint.

The backend audit endpoint maintains a **seen-nonce set** (KV, 24h TTL) keyed by `(wallet_commitment, nonce_commitment)`. A second submission with the same pair is rejected. This prevents the same proof being submitted against a *different* `(url, selector)` because both are inside the nonce-commitment hash — modifying either invalidates the proof.

This is identical in shape to the EIP-712 nonce dance the x402 substrate already uses (`X-PAYMENT` headers; see `backend/src/middleware/x402-gate.ts` Flex envelope) — we are copying the discipline, not the encoding.

---

## Honest budget (prover time, proof size, PK size)

For a ~300 k-constraint Groth16 circuit, EdDSA-on-Baby-Jubjub + Poseidon-based Merkle (depth 20):

| Metric | Target | Notes |
|---|---|---|
| Prover wall-clock (M1 / M2 laptop) | 1.5–3 s | First fill includes ~2 s PK load; subsequent fills under 2 s. |
| Prover wall-clock (older Intel laptop) | 4–8 s | Acceptable; we surface "signing fill…" UX. |
| Prover wall-clock (target) | <500 ms | **Not realistic** at 300 k constraints with Groth16-on-arkworks-wasm. Lewis's <500 ms target is a v8 number once Plonky2 / GPU-prove matures, not v7.x. |
| Proof size | ~200 bytes | Trivial. |
| Verifier wall-clock (CF Worker) | <10 ms | Negligible. |
| Proving key size | 30–80 MB | One-time CDN download, cached. |
| Verification key size | <5 KB | Bundled in backend. |
| Witness assembly (TS side) | <50 ms | Hashing + Merkle path build. |

**Honest verdict on prover budget:** sub-second is not a v7 deliverable; 1–3 seconds is. UX must show a non-blocking "signing fill" affordance. Treating the prover as instant is the most common failure mode of agent-side ZK and we are explicit that we will not pretend.

---

## Phased rollout: v7.0 (sig-shape) → v7.x (SNARK)

This subproject is **months** of real work. We do not ship a half-circuit. We ship the **shape** first, then add the SNARK behind the same interface.

### v7.0 (atomic Kuri rip; ships within the v7 cut)
- Pointer-only fill in the runtime: `unbrowse_fill` accepts `op://…` / `keychain://…` URIs and the cleartext is dereferenced inside the fill runtime only.
- The runtime emits a **fill receipt** signed with the **x402 wallet's Ed25519 key** (not in-circuit; plain signature) over `(pointer_uri_hash, nonce, url, selector, iat)`.
- Receipt POSTed to `/v1/audit/fill-receipt`. Backend stores receipt + signature + wallet pubkey + receipt hash. No cleartext, no value.
- Logs are scrubbed for any field that the fill runtime touched; assert via existing `scripts/precommit.sh` extension.
- This is **NOT zero-knowledge** — it reveals the wallet pubkey on the wire — but it **already satisfies the no-cleartext-logged invariant** and gives us the full pipeline (receipt schema, audit log, verifier route) under exercise.

### v7.1 — circuit prototype (1 month after v7.0)
- circom + snarkjs proof-of-concept of the predicate, on a tiny Merkle depth (e.g., 8), to validate end-to-end wiring through bun → wasm → backend verifier.
- Not shipped to users yet. Internal dev gate only.

### v7.2 — arkworks rewrite + Phase 2 ceremony (2 months after v7.0)
- Rewrite circuit in arkworks-rs.
- Run Phase 2 ceremony.
- Bench prover on real laptops; tune Merkle depth and gadget choices to land in the 1–3 s budget.

### v7.3 — production rollout (3 months after v7.0)
- Replace the v7.0 plain-ed25519 receipt with the Groth16 proof at the same `/v1/audit/fill-*` surface.
- Old receipts remain valid in audit log (do not invalidate history); new fills emit proofs.
- Cutover is a flag flip — same pointer-only fill UX, stronger underlying claim.

### Realistic shipping date
If we assign **one half-time engineer** starting at v7.0 cut:
- v7.0 sig-shape: **same week as v7 cut** (it's already in the rip scope).
- v7.1 prototype: **~4 weeks later**.
- v7.2 arkworks + ceremony: **~8–10 weeks later**.
- v7.3 production rollout: **~12 weeks (3 months) after v7.0**.

This is not a hidden punt. The scope cut is explicit: **v7.0 ships pointer-only + ed25519-signed audit receipt; the SNARK lands in v7.3 ≈ 3 months later.** The receipt-and-audit interface is built once and the SNARK swaps in behind it.

---

## Existing substrate (what's already there)

These files are the real x402/wallet/attestation surface we build on; do not re-invent.

- `src/payments/wallet.ts` — wallet precheck (configured + provider). Today reads `~/.lobster/agents.json` for the active wallet. v7 binding extends this to read both x402 + ZK pubkeys from the keychain.
- `src/payments/generic-x402-adapter.ts` — provider-agnostic adapter factory (lobster, pay.sh, privy, fluxa, coinbase, okx, circle, venice, moonpay, bankr, agentcash, etc.). Wallet identity is provider-pluggable; the ZK binding rides above it.
- `src/payments/{lobster-pay,paysh-pay,privy-pay,flex-pay,x402-fetch}.ts` — per-provider payment paths, all already conformant to the lobster-cash shape.
- `src/vault/index.ts` — OS keychain wrapper (keytar) with encrypted-file fallback. **This is the bootstrap target** for the v7 keypair storage. Existing fallback (`~/.unbrowse/vault.enc`) inherits.
- `backend/src/middleware/sponsor.ts` — the existing platform x402-sponsor surface (PLATFORM_SPONSOR_WALLET_ADDRESS, daily caps, ledger rows). Documents wallet env contract.
- `backend/src/middleware/x402-gate.ts` — Flex-facilitator envelope shape (`X402PaymentRequirementV2`), `X-PAYMENT` header surface. The proof-submission route reuses the request-shape conventions.
- `backend/src/services/sponsor-flex.ts` — the in-tree Ed25519 signing flow (`@faremeter/flex-solana` + Web Crypto Ed25519). Establishes the *coding pattern* for signing flows in the backend; the proof verifier route lives next to it.
- `backend/src/services/declare-signature.ts` — Ed25519 sign/verify pair already wired to Web Crypto.
- `backend/src/lib/attestation.ts` — `LEWIS_DEPLOYER_PUBKEY_v1` lineage substrate. **The unbrowse team master key for v7 wallet attestation reuses this hierarchy; do not invent a new root.**
- `backend/scripts/verify-bypass.ts` — Ed25519 verification scaffold for substrate gates.

What is NOT present (must be built):
- Any Baby-Jubjub / Poseidon primitives in TS or wasm.
- Any R1CS / Groth16 prover or verifier integration.
- A `packages/zk-fill/` workspace.
- A circuit-id → PK URL CDN.
- The `/v1/audit/fill-receipt` and `/v1/audit/fill-proof` routes.

---

## Open questions

1. **Curve choice — Baby-Jubjub vs Ed25519-Ristretto-as-gadget.** Baby-Jubjub gives 5–8× prover speedup; cost is a second keypair per install. Sign off needed.
2. **Authorized-pointers root membership.** Who declares which pointers a wallet is authorized over? Proposed: the same vault — when a pointer is added to the vault, its Poseidon hash is added to a per-wallet Merkle tree maintained client-side; the root rotates per add. The root signs into the install's attestation receipt. Sign off needed.
3. **Merkle depth.** Depth 20 supports 1 M pointers/wallet — plenty. Depth 16 = 65 k, smaller circuit, still enough. Decide at v7.1 prototype.
4. **Per-fill nonce storage on backend.** KV with 24h TTL, keyed by `(wallet_commitment, nonce_commitment)`. Cost on Cloudflare: trivial. Confirm KV namespace allocation.
5. **Ceremony coordination.** Who are the 3–5 Phase 2 contributors? Lewis + at least two external eyes for credibility. Schedule for v7.2 window.
6. **Browser-prover variant.** Some users will want to drive unbrowse from a browser extension (OpenClaw / @unbrowse/sdk). Wasm prover works in browsers but the 30–80 MB PK is brutal over a CDN to a browser cache. Decide: browser path uses a hosted proving service (compromise: not zero-knowledge against unbrowse) OR ships only the audit-receipt sig-shape, no SNARK. Lean toward sig-shape only for browser; SNARK only in CLI.
7. **Existing wallet rotation.** Many users already have an x402 wallet via lobster/pay.sh/privy. We must NOT force them to regenerate. The bootstrap attests the *companion* ZK key to the *existing* x402 pubkey; the x402 spend identity stays.
8. **Cleartext-log scrubber.** v7.0 must add a precommit + runtime assertion that no fill value ever touches stdout/stderr/log files. Where does this live — `src/logger.ts`? Today logs flow through `log()` in `src/logger.ts`; need a tainted-string type for fill values.
