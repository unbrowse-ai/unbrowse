/**
 * graph-checkpoint.test — the witness for plan node 3 (on-chain-ready checkpoint).
 * Proves: the checkpoint root equals graphRoot; every admitted endpoint has an inclusion
 * proof that verifies under the root; an endpoint not in the graph cannot be proven; and a
 * wrong deltaId or a tampered audit step fails closed.
 */
import { describe, expect, it } from "bun:test";
import { signDelta, shapePointer, deltaId } from "../src/values/route-delta.js";
import { emptyGraph } from "../backend/src/services/graph-merge/index.js";
import { graphRoot } from "../backend/src/services/graph-merge/index.js";
import { checkpoint, inclusionProof, verifyInclusion } from "../backend/src/services/graph-checkpoint.js";

async function graphOf(endpoints: string[]) {
  const g = emptyGraph();
  for (const e of endpoints) {
    const d = await signDelta({ op: "add", endpoint: e, shape: shapePointer({ e }), freshness: 1000 });
    g.winners.set(e, d);
  }
  return g;
}

const ENDPOINTS = [
  "GET api.a.com/v1/x", "GET api.b.com/v1/y", "GET api.c.com/v1/z",
  "POST api.d.com/v1/w", "GET api.e.com/v1/q", // 5 ⇒ exercises odd promotion
];

describe("graph-checkpoint (plan node 3)", () => {
  it("the checkpoint root equals graphRoot", async () => {
    const g = await graphOf(ENDPOINTS);
    expect(checkpoint(g).root).toBe(graphRoot(g));
    expect(checkpoint(g).n).toBe(5);
  });

  it("every admitted endpoint has an inclusion proof that verifies under the root", async () => {
    const g = await graphOf(ENDPOINTS);
    const root = checkpoint(g).root;
    for (const e of ENDPOINTS) {
      const proof = inclusionProof(g, e);
      expect(proof).not.toBeNull();
      const did = deltaId(g.winners.get(e)!);
      expect(verifyInclusion(root, e, did, proof!)).toBe(true);
    }
  });

  it("an endpoint not in the graph cannot be proven", async () => {
    const g = await graphOf(ENDPOINTS);
    expect(inclusionProof(g, "GET api.nothere.com/v1/nope")).toBeNull();
  });

  it("a wrong deltaId fails closed", async () => {
    const g = await graphOf(ENDPOINTS);
    const root = checkpoint(g).root;
    const e = ENDPOINTS[2];
    const proof = inclusionProof(g, e)!;
    expect(verifyInclusion(root, e, "0".repeat(64), proof)).toBe(false); // not the committed delta
  });

  it("a tampered audit step fails closed", async () => {
    const g = await graphOf(ENDPOINTS);
    const root = checkpoint(g).root;
    const e = ENDPOINTS[0];
    const did = deltaId(g.winners.get(e)!);
    const proof = inclusionProof(g, e)!;
    if (proof.length > 0) {
      const tampered = [{ ...proof[0], hash: (BigInt("0x" + proof[0].hash) ^ 1n).toString(16).padStart(64, "0") }, ...proof.slice(1)];
      expect(verifyInclusion(root, e, did, tampered)).toBe(false);
    }
    // a proof from a different endpoint must not verify for this leaf
    const otherProof = inclusionProof(g, ENDPOINTS[1])!;
    expect(verifyInclusion(root, e, did, otherProof)).toBe(false);
  });
});
