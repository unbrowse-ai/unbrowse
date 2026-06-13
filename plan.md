# Plan — production-harden the ZK-gated delta contribution

> Continuation of `internal/zk-delta-contribution-plan.md` (the 6-node spine, shipped +
> on staging at `unbrowse-backend-staging`). This plan moves the four **honest deploy-step
> boundaries** from reference to production — each was left as a reference floor with a clear
> upgrade path; the verify/merge interfaces never change, only the carrier does. Witness:
> `scripts/zk-delta-prod-gate.sh` exits 0 iff every node is real + tested. No fabricated green.

## Goal (one line)

The shared-graph contribution runs on production-grade rails: a dedicated store, an
execution attestation whose carrier can be a third-party notary proof (not only a wallet
self-signature), an auditable on-chain-ready checkpoint with inclusion proofs, and a
contributor payout wired into the four-way fare split — each with the real external wiring
(chain RPC / MPC-TLS notary / USDC transfer) named as the final deploy step, not faked.

## Where it stands (the floor this builds on)

| Shipped (staging-green) | The boundary this plan crosses |
|---|---|
| `graph-store` persists winners+ledger in STATS_KV under a `contrib:` prefix | → a **dedicated** graph namespace, isolated from analytics |
| `exec-attest`: wallet self-signature binds origin+shape | → a **pluggable proof carrier**: wallet-sig OR a notary (zkTLS/TLSNotary) proof |
| `graphRoot`: RFC-6962 root returned by `/v1/contribute/root` | → an **auditable checkpoint** with per-endpoint inclusion proofs, ready to anchor on-chain |
| `settleContributorShare`: the contributor leg, in isolation | → wired into the **four-way fare split** (platform/owner/contributor/discoverer = 100%) |

## Phased build (cheapest-first; each node = goal · primitive · witness)

| # | node · goal | primitive to add | witness (exit 0 ⇔ done) |
|---|---|---|---|
| 1 | **dedicated-graph-kv** — resolve a dedicated `GRAPH_KV` binding (fall back to STATS_KV prefix), keys namespaced + isolated | `graph-store.resolveGraphKV` | `tests/graph-store-dedicated.test.ts` — prefers GRAPH_KV when bound; isolated keys; graceful fallback |
| 2 | **notary-attestation** — the attestation carries a pluggable proof: wallet-sig (today) OR a notary proof over origin+shape; verify dispatches on the carrier | `src/capture/exec-attest.ts` notary carrier + `verifyNotary` (reference notary keypair models the MPC-TLS output) | `tests/notary-attest.test.ts` — notary-carried attestation verifies; wallet-sig path intact; forged notary fails closed |
| 3 | **onchain-checkpoint** — batch the winner state into a checkpoint with RFC-6962 inclusion proofs (the value an on-chain anchor publishes) | `backend/src/services/graph-checkpoint.ts` (merkleProof/verifyProof over the sorted winners) | `tests/graph-checkpoint.test.ts` — checkpoint root == graphRoot; inclusion proof verifies; out-of-graph endpoint can't prove; tamper breaks it |
| 4 | **contributor-payout** — settle a paid execution across the four-way split, the contributor leg paid to the verified graph winner only | `backend/src/routes/contribution.ts` `settleExecution` (full split, bps-configured) | `tests/contributor-payout.test.ts` — splits sum to the charge; winner earns the contributor leg; a non-winner earns nothing |
| 5 | **goal** — all four real + tested; boundary honest | — | `scripts/zk-delta-prod-gate.sh` exits 0 |

## Honest deploy-step boundaries (named, not faked — mirrors zk-gate's scope note)

- **Node 2**: the reference notary is a local keypair signing the attested fields. The real
  MPC-TLS / TLSNotary web-proof (a third party attesting the actual TLS session) plugs into
  the SAME `verifyNotary` interface via `UNBROWSE_NOTARY_URL` — the deploy step.
- **Node 3**: the checkpoint + inclusion proofs run in-process. Publishing the root to a
  chain (Solana proof-of-history / IQLabs signed table) is the deploy step; the committed
  value is exactly this root.
- **Node 4**: the split is computed + attributed by proof. Moving USDC over x402 is the
  existing payment rail (the deploy step); this decides WHO is paid, verifiably.

## Boundary discipline

Prover stays client-side (`src/`), verifier/checkpoint/payout stay server-side (`backend/`).
The gate's boundary check fails if any `src/` file imports the server checkpoint/payout.
The notary carrier is client-constructible but notary-verified server-side.

## WALK status — COMPLETE (`scripts/zk-delta-prod-gate.sh` exits 0; 4/4, 20 tests, stable 3/3)

- [x] node 1 — dedicated-graph-kv · `graph-store.resolveGraphKV` (+ Env `GRAPH_KV?`, route wired) · `tests/graph-store-dedicated.test.ts` (5✓): prefers dedicated, prefix-isolated fallback, full isolation
- [x] node 2 — notary-attestation · `exec-attest` `NotaryProof`/`referenceNotary`/`verifyNotary` · `tests/notary-attest.test.ts` (6✓): notary verifies, wallet path intact, untrusted/tampered/origin-swap fail closed
- [x] node 3 — onchain-checkpoint · `backend/.../graph-checkpoint.ts` (RFC-6962 inclusion proofs) · `tests/graph-checkpoint.test.ts` (5✓): root == graphRoot, every endpoint proves, out-of-graph can't, tamper fails
- [x] node 4 — contributor-payout · `contribution.settleExecution` (four-way split) · `tests/contributor-payout.test.ts` (4✓): legs sum to charge, winner earns, forged earns nothing, bad split rejected
- [x] goal — `scripts/zk-delta-prod-gate.sh` exits 0; first spine still green (29✓, no regression); backend compiles

No fabricated green: every node's test fails closed on the adversarial path; reliability 3/3 cold.

Deploy-step boundaries remain honest and unchanged: the real MPC-TLS notary service (node 2,
`UNBROWSE_NOTARY_URL`), on-chain root publication (node 3), live USDC transfer over x402
(node 4), and provisioning/binding a dedicated `GRAPH_KV` namespace on staging (node 1) are
the external wiring — the in-process logic they plug into is settled here.

(Prior plan: pay.sh support — WALK COMPLETE, preserved in git history.)
