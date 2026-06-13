/**
 * graph-checkpoint — the on-chain-ready checkpoint of the shared route graph (plan node 3).
 * SERVER-ONLY. "Value off-chain, root on-chain": the winners + ledger stay in KV; this
 * computes the RFC-6962 Merkle root (identical to graphRoot) PLUS a per-endpoint inclusion
 * proof, so any auditor can verify a specific route is committed under the published root
 * without the whole graph. Publishing the root to a chain (Solana proof-of-history / IQLabs
 * signed table) is the deploy step; the value it would publish is exactly this root.
 *
 * The tree matches sealed-ledger's merkleRoot (used by graphRoot): leaf = sha256("\x00" +
 * endpoint + ":" + deltaId); node = sha256(0x01 || left || right); an odd node is promoted
 * unchanged. Promotion is identity, so the audit path simply omits promoted levels and the
 * verifier folds the path in order — no need to know which levels promoted.
 */
import { graphRoot, type SharedGraph } from "./graph-merge/index.js";
import { deltaId } from "../../../src/values/route-delta.js";
import { sha256hex } from "../../../src/values/content-address.js";
import { createHash } from "node:crypto";

const NODE_PREFIX = 0x01;
const leafHex = (endpoint: string, did: string): string => sha256hex(`\x00${endpoint}:${did}`);
const hashNode = (l: Buffer, r: Buffer): Buffer =>
  createHash("sha256").update(Buffer.concat([Buffer.from([NODE_PREFIX]), l, r])).digest();

/** One step of an audit path: a sibling hash and which side it sits on. */
export interface InclusionStep {
  hash: string;  // sibling node hash (hex)
  right: boolean; // true ⇒ sibling is the RIGHT child (running hash is the left)
}

/** A checkpoint: the published commitment + the leaf count it covers. */
export interface Checkpoint {
  root: string;
  n: number;
}

/** The winner leaves in the SAME deterministic order graphRoot uses (sorted by endpoint). */
function sortedLeaves(g: SharedGraph): { endpoint: string; did: string; leaf: Buffer }[] {
  return [...g.winners.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([endpoint, d]) => {
      const did = deltaId(d);
      return { endpoint, did, leaf: Buffer.from(leafHex(endpoint, did), "hex") };
    });
}

/** The checkpoint = the graph's Merkle root + leaf count. root === graphRoot(g). */
export function checkpoint(g: SharedGraph): Checkpoint {
  return { root: graphRoot(g), n: g.winners.size };
}

/** Audit path proving `endpoint`'s winning delta is committed under the checkpoint root, or
 *  null if the endpoint is not an admitted winner (no proof can be forged for it). */
export function inclusionProof(g: SharedGraph, endpoint: string): InclusionStep[] | null {
  const leaves = sortedLeaves(g);
  let idx = leaves.findIndex((l) => l.endpoint === endpoint);
  if (idx < 0) return null;
  let level = leaves.map((l) => l.leaf);
  const proof: InclusionStep[] = [];
  while (level.length > 1) {
    if (idx % 2 === 0) {
      if (idx + 1 < level.length) proof.push({ hash: level[idx + 1].toString("hex"), right: true });
      // else: promoted (no sibling at this level)
    } else {
      proof.push({ hash: level[idx - 1].toString("hex"), right: false });
    }
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashNode(level[i], level[i + 1]) : level[i]);
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Verify an inclusion proof: fold the audit path from the (endpoint, deltaId) leaf and
 *  check it reproduces `root`. A wrong deltaId, a tampered step, or a path for a different
 *  leaf fails closed. */
export function verifyInclusion(root: string, endpoint: string, did: string, proof: InclusionStep[]): boolean {
  let h = Buffer.from(leafHex(endpoint, did), "hex");
  for (const s of proof) {
    const sib = Buffer.from(s.hash, "hex");
    h = s.right ? hashNode(h, sib) : hashNode(sib, h);
  }
  return h.toString("hex") === root;
}
