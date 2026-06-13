/**
 * graph-merge — the ZK-GATED CRDT MERGE into the shared route graph (plan node 4,
 * internal/zk-delta-contribution-plan.md). SERVER-ONLY: the contributor constructs and
 * proves a delta; this service is the gate that admits it. No client (src/) file may
 * import this (enforced by scripts/zk-delta-gate.sh's boundary check).
 *
 * This is the leg the literature leaves open (the 2026-06-12 sweep found no verifiable-CRDT
 * write): a cross-agent delta is admitted into the shared graph ONLY behind all three
 * checks — the delta's own signature, its bounded-validity proof (node 2), and its
 * execution attestation bound to the same route (node 3). Admitted deltas resolve as a
 * last-writer-wins register per endpoint (freshness, tie-broken by delta id), which is a
 * conflict-free / commutative CRDT: merging the same admitted set in ANY order converges to
 * the same winners, so the Merkle root over the converged state is reproducible across
 * agents (the "two witnesses" property). The root is RFC-6962, reusing sealed-ledger's
 * commitment (value off-chain, root on-chain) — the on-chain checkpoint is the deploy step.
 */
import { verifyDelta, deltaId, type RouteDelta } from "../../../../src/values/route-delta.js";
import { verifyDeltaValidity, type DeltaValidityProof } from "../../../../src/values/delta-proof.js";
import {
  verifyAttestation, attestationBindsDelta, type ExecAttestation,
} from "../../../../src/capture/exec-attest.js";
import { merkleRoot } from "../../../../src/values/sealed-ledger.js";
import { sha256hex } from "../../../../src/values/content-address.js";

/** The shared graph: a last-writer-wins register of the winning delta per endpoint. */
export interface SharedGraph {
  winners: Map<string, RouteDelta>;
}

/** A contribution = the delta plus the two proofs that gate its admission. */
export interface Contribution {
  delta: RouteDelta;
  validity: DeltaValidityProof;
  attestation: ExecAttestation;
}

/** The outcome of attempting to merge one contribution. */
export interface AdmitResult {
  admitted: boolean;
  reason?: "bad-signature" | "bad-validity-proof" | "bad-attestation" | "attestation-unbound" | "stale";
}

export function emptyGraph(): SharedGraph {
  return { winners: new Map() };
}

/** The ZK gate + LWW comparison for ONE endpoint, against its CURRENT winner (or null). This
 *  is the O(1) per-endpoint core: the route loads just the endpoint's winner, calls this, and
 *  persists a single key on admit — no whole-graph load/save. Unproven / unattested / forged /
 *  stale ⇒ rejected. */
export function gateAndCompare(current: RouteDelta | null, c: Contribution): AdmitResult {
  const { delta, validity, attestation } = c;
  if (!verifyDelta(delta, delta.walletRoot)) return { admitted: false, reason: "bad-signature" };
  if (!verifyDeltaValidity(delta, validity)) return { admitted: false, reason: "bad-validity-proof" };
  if (!verifyAttestation(attestation, delta.walletRoot)) return { admitted: false, reason: "bad-attestation" };
  if (!attestationBindsDelta(attestation, delta)) return { admitted: false, reason: "attestation-unbound" };
  if (current && !winsOver(delta, current)) return { admitted: false, reason: "stale" };
  return { admitted: true };
}

/** Gate one contribution and, if every check passes, CRDT-merge it into the in-memory graph
 *  (LWW by freshness, tie-broken by delta id). Mutates `g`. (The persistent path uses
 *  gateAndCompare + per-endpoint store writes; this stays for the in-memory/convergence tests.) */
export function mergeDelta(g: SharedGraph, c: Contribution): AdmitResult {
  const r = gateAndCompare(g.winners.get(c.delta.endpoint) ?? null, c);
  if (r.admitted) g.winners.set(c.delta.endpoint, c.delta);
  return r;
}

/** Deterministic LWW order: fresher wins; equal freshness broken by higher delta id.
 *  Total + antisymmetric ⇒ merge is commutative/associative ⇒ convergent across agents. */
function winsOver(a: RouteDelta, b: RouteDelta): boolean {
  if (a.freshness !== b.freshness) return a.freshness > b.freshness;
  return deltaId(a) > deltaId(b);
}

/** RFC-6962 Merkle root over the CONVERGED winner state (sorted by endpoint), so two
 *  agents that admitted the same set — in any order — compute the same root. */
export function graphRoot(g: SharedGraph): string {
  const leaves = [...g.winners.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([endpoint, d]) => sha256hex(`\x00${endpoint}:${deltaId(d)}`));
  return merkleRoot(leaves);
}
