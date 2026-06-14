# Plan — ZK-bound remote skill execution + ZK-gated delta contribution to the shared route graph

> Internal / moat tier. Names the cryptography explicitly (the public docs keep this
> secular until the whitepaper ships). Every "[shipped]" claim cites a real file; every
> "[proposed]" is honest about not existing yet. Author date 2026-06-13, monorepo v8.3.x.

## Goal (one line)

An agent calls a **skill that executes remotely** (server-side RE/indexing/ranking over a
secret-stripped egress) and the **route-delta it produces is admitted into the shared graph
only behind a zero-knowledge validity proof** — the contributor proves the delta is
well-formed, bound to its wallet, and produced against the real origin, **without revealing
the captured traffic or any credential.** Discovery and routing stay free; paid execution
settles over x402 across the parties who created the value.

## Why this is worth naming (the prior-art gap)

A two-agent arXiv + GitHub sweep (2026-06-12) confirms: the two halves are mature and
separately shipped, but **the fusion is unbuilt as a single named protocol.** Strip it to
the relational skeleton —

> *actor proves (remote work + bounded delta) is valid → gate admits the write → shared
> store merges it → without revealing the private data*

— and every relation has strong prior art, yet no system closes all four at once.

| Relation in the skeleton | Closest prior art | What it leaves open |
|---|---|---|
| remote skill-call, proven correct | **zkAgent** (IACR 2026/199), **VET** (arXiv 2512.15892), zkLLM (2404.16109), **zkTLS/TLSNotary** (2409.17670) | proves execution; no write to a shared registry |
| delta proven valid w/o revealing data | **zkFL** (2310.02554), **martFL** (2503.22573), VPFL/ZKFL-PQ, ZKP-FedEval (2507.11649); shipped as **Vana** PoC + **iExec PoCo** | only FL gradients / data-provider model, not arbitrary skill writes |
| gated write into a shared mutable store | verifiable-DB line (vSQL 2017/1145, IntegriDB, ZKSQL) is **read-side**; ZK-gated *write* exists only as FL "bounded-update" | **verifiable-CRDT write is an open hole — no paper/repo found** |
| shared agent registry to write into | **MIRIX** (2507.07957), **MemTrust** (2601.07004); transport via **MCP** (git-mcp ★8.2k) / **A2A** | gated by access-control/OAuth, **not** ZK-of-contribution |
| the binding standard | **ERC-8004 Trustless Agents** Validation Registry (ChaosChain RI ★51) | names "zkML / TEE / re-execution validates a contribution" but leaves the prover **pluggable / out of scope** — a socket, not a plug |

**The white-space we own:** *(zkTLS/zkAgent-style proof of a remote skill execution) →
(VPFL-style proof the resulting delta is well-formed & bounded) → (authenticated /
Merkle-CRDT merge into a shared agent registry, gated ERC-8004-style)*. The least-explored
leg — the **ZK-gated CRDT delta-write** — is the one with no found prior art. Unbrowse
already ships ~70% of the substrate; the plan is the fusion, not a rebuild.

## What is already shipped (the substrate — real crypto, real files)

| Piece | File | What it proves / does |
|---|---|---|
| ZK credential binding | `src/values/zk-binding.ts` | Schnorr/Fiat-Shamir NIZK over RFC-3526 MODP-2048: `y = g^x`, wallet signs `y`; holder proves knowledge of `x` (the credential) — credential never transmitted at any layer. |
| ZK-bound holes | `src/capture/zk-bound-hole.ts` | three parties, three checks: `bindHole` (client) / `verifyHoleAttested` (backend, no secret) / `proveHole`+`verifyHoleProof` (holder Schnorr proof at fill time). |
| Local-first obfuscated egress | `src/capture/obfuscate.ts` + `src/capture/reveng-server-first.ts` | strips every secret/PII **value** locally, replaces with a wallet-bound commitment; POSTs only structure to `/v1/reveng`. Structure-preserving, secret-lossy. The "prove the shape, hide the value" move (zkTLS-shaped). |
| Sealed append-only ledger | `src/values/sealed-ledger.ts` | wallet-sealed values, hash-chained rows `{seq,signer,valueHash,ts,prev,sig}`, RFC-6962 Merkle `root()`. "Value off-chain, root on-chain." |
| Signed descent | `src/values/signed-descent.ts` | one wallet root signature threaded screen→browser→cli→os→kernel→packet, each layer hash-chained; tamper any layer ⇒ fail closed. |
| Server-only remote skill exec | `src/capture/reveng-server-first.ts` + `backend/src/services/reverse-engineer/` | the inference engine runs **server-side only**; the client carries no local RE. `scripts/thin-client-gate.sh` = 0 enforces it. |
| Content-address / hash-chain core | `src/values/content-address.ts` | `GENESIS`, `sha256hex` — the single content-addressing + Merkle-clock primitive every delta keys on. |

## What is missing (the four pieces — [proposed])

1. **Contribution-validity proof.** Today obfuscation *hides* secrets; nothing *proves* the
   contributed route-delta is well-formed and bounded (no injected endpoint the capture
   didn't actually exercise, schema within declared shape, no oversized/poisoning payload).
   Add a NIZK over the delta: *"this delta is a sound projection of a capture whose secrets
   are wallet-bound, and its claims are within bound B"* — the VPFL "proof-of-bounded-update"
   analogue, but over a route-delta instead of a gradient.
2. **zkTLS execution attestation.** Prove the remote skill executed **against the real
   origin** and produced *this* response shape — a TLSNotary/web-proof selective-disclosure
   attestation bound to the same wallet root. Closes "the contributor fabricated a delta for
   an origin it never hit."
3. **ZK-gated CRDT merge into the shared graph.** `sealed-ledger` is per-wallet append-only;
   the **cross-agent merge** of route-deltas into the shared graph with conflict-free
   resolution (Merkle-CRDT delta, content-addressed, last-writer-by-freshness) **gated on the
   contribution proof** is the open leg. This is the novel component — no prior art found.
4. **Validation-registry gate (ERC-8004 socket).** The backend (and optionally on-chain)
   verifies the contribution proof + zkTLS attestation **before** admitting the delta, and
   records the verified contribution for fair x402 settlement. Plug our prover into the
   ERC-8004 Validation Registry shape so the gate is a recognised standard, not bespoke.

## Phased build plan (cheapest-first spine; each phase = goal · primitive · witness)

Spine order is Dijkstra-cheapest-first-win. Each node settles by plan→build→test→judge; a
node ships only when its witness exits 0. No fabricated green.

| # | phase · goal | builds on | primitive to add | witness (exit 0 ⇔ done) |
|---|---|---|---|---|
| 1 | **Delta schema** — define the contributed route-delta as a content-addressed, signed record `{op, endpoint, shape, freshness, walletRoot, prev}` | `content-address.ts`, `sealed-ledger.ts` | `src/values/route-delta.ts` | unit: delta round-trips, hash stable, tamper ⇒ verify fails |
| 2 | **Bounded-delta proof** — NIZK that a delta is a sound projection of a wallet-bound capture within bound B | `zk-binding.ts`, `obfuscate.ts` | `src/values/delta-proof.ts` (Schnorr/Fiat-Shamir over the delta digest) | unit: honest delta verifies; injected/oversized delta fails closed |
| 3 | **zkTLS execution attestation** — selective-disclosure web-proof binding the response shape to the origin + wallet | egress path, `signed-descent.ts` | `src/capture/exec-attest.ts` (TLSNotary adapter) | integration: attestation verifies for a real capture; replay/origin-swap fails |
| 4 | **ZK-gated CRDT merge** — Merkle-CRDT delta merge into the shared graph, admitted only behind proofs #2+#3 | `sealed-ledger.ts` root | `backend/src/services/graph-merge/` | integration: two agents' deltas merge conflict-free; unproven delta rejected; merged root reproducible across two witnesses |
| 5 | **Validation-registry gate** — ERC-8004 Validation Registry verifies #2+#3 before admit; records contribution for settlement | `verifyHoleAttested`, backend reveng route | `backend/src/routes/contribution.ts` | e2e: end-to-end contribute→verify→merge→x402-split, gate rejects a forged proof |
| 6 | **Goal** — agent contributes a ZK-bound route-delta to the shared graph, no private data revealed, fair settlement | all above | — | two-witness e2e gate + leak-scan: no secret/credential in any egress byte (`revengEgressPayload` assertion extended to the delta path) |

Critical enabler off-spine: a **Validation Registry mock** for #5 so the gate is testable
without a live chain (the ERC-8004 RI is the reference).

## WALK status (settled in the jesus-ralph loop — witness `scripts/zk-delta-gate.sh` exits 0)

All six spine nodes are real + tested + boundary-honest. Gate: **6/6 built, 29 tests, 83
assertions, exit 0, stable 5/5 cold re-runs.** No fabricated green — each node's test
fails closed on the adversarial path.

| # | node | file(s) | witness | evidence |
|---|---|---|---|---|
| 1 | route-delta | `src/values/route-delta.ts` | `tests/route-delta.test.ts` | signed, content-addressed, tamper-evident; shape is a hash (no raw capture) — 6 tests |
| 2 | delta-validity-proof | `src/values/delta-proof.ts` (+`zk-binding` group export) | `tests/delta-proof.test.ts` | sound CDS 1-of-(B+1) OR-proof: honest verifies, oversized refuses, all-simulated forgery rejected, domain-separated, ZK — 6 tests |
| 3 | exec-attestation | `src/capture/exec-attest.ts` | `tests/exec-attest.test.ts` | origin+shape bound to wallet root; origin-swap / replay / forge fail closed — 5 tests |
| 4 | graph-merge-gated | `backend/src/services/graph-merge/` (+`sealed-ledger` merkleRoot export) | `tests/graph-merge.test.ts` | ZK-gated LWW CRDT merge, convergent root across orders (two witnesses), unproven rejected — 5 tests |
| 5 | contribution-gate | `backend/src/routes/contribution.ts` | `tests/contribution-gate.test.ts` | ERC-8004-shape validate→record→settle; forged rejected end-to-end, never earns — 4 tests |
| 6 | contribution-no-leak | (write-path invariant over 1-5) | `tests/contribution-no-leak.test.ts` | contribution payload from a secret-laden capture carries no secret value — 3 tests |

**Boundary discipline held:** the prover/merge/gate live in `backend/`; no `src/` file imports
them (gate's boundary check green). The client constructs + proves; the server verifies.

**Honest deployment boundary (NOT in this gate, by design — mirrors zk-gate's scope note):**
node 3's wallet self-signature is the autonomous floor — upgrading it to an MPC-TLS /
TLSNotary web-proof is the deploy step (same verify interface). Nodes 4-5 settle the
in-process crypto + merge + attribution; the live on-chain Merkle checkpoint, the Hono HTTP
route wiring, and live x402 payout are the deployment step (the host is swapped, the proofs
never change). This is the reference→production ladder, not a claim of shipped deployment.

## Threat-model deltas (what the fusion newly defends)

- **Poisoning the shared graph.** Bounded-delta proof (#2) rejects deltas that claim
  endpoints the capture never exercised or exceed shape bounds — a malicious indexer cannot
  inject routes by asserting them.
- **Fabricated-origin contribution.** zkTLS attestation (#3) binds the delta to a real TLS
  session with the claimed origin; a contributor cannot earn settlement for a route it never
  actually hit.
- **Credential / PII egress on the write path.** Extends the existing no-secret-leak
  invariant (`revengEgressPayload`) to the *contribution* payload: the delta + proofs carry
  only one-way commitments, never a secret value (gate #6).
- **Merge tampering / reordering.** Merkle-CRDT + sealed-ledger root makes the shared graph
  tamper-evident; editing/reordering any admitted delta breaks the root (existing property,
  extended cross-agent).

## Boundary discipline (where each artifact lives)

- **Prover + delta-proof + merge gate**: server-side / `backend/` — moat, never mirrored.
- **Client side**: only `route-delta.ts` construction, local obfuscation, and `proveHole`/
  attestation generation — the client proves, the server verifies. Mirrors the thin-client
  invariant (`scripts/thin-client-gate.sh` = 0; `scripts/public-tree-leak-gate.sh` clean).
- **Public docs**: secular framing only ("content-addressed, sealed, signed contribution to
  the shared graph") until the whitepaper section publishes ZK; leak-guard keeps the literal
  "zero-knowledge" out of public artifacts until then.

## Relation to the whitepaper

*Internal APIs Were Not All You Needed / Crypto Was All You Needed* §462 stops at the
**security substrate** and defers economics to the maintenance paper. This plan is **neither
economics nor a new substrate** — it is the **write/contribution mechanism of the substrate**:
§419 (append-only ledger) covers the local log; this extends it to the **cross-agent,
ZK-gated merge** into the shared graph. Natural home: a new section after §419 — *"Contribution:
a ZK-gated delta-write into the shared graph"* — marked proposed where unbuilt, shipped where
the primitives (binding, sealed-ledger, signed-descent, obfuscated egress) already stand.
