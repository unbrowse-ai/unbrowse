/**
 * graph-merge.test — the witness for plan node 4 (ZK-gated CRDT merge).
 * Proves: a fully-proven contribution is admitted; an unproven, unattested, or unbound
 * contribution is rejected and leaves the graph unchanged; LWW staleness holds; and the
 * merge is convergent — two agents admitting the same set in different orders compute the
 * same Merkle root (the two-witness / reproducible-root property).
 */
import { describe, expect, it } from "bun:test";
import { signDelta, shapePointer } from "../src/values/route-delta.js";
import { proveDeltaValidity } from "../src/values/delta-proof.js";
import { attestExecution } from "../src/capture/exec-attest.js";
import {
  emptyGraph, mergeDelta, graphRoot, type Contribution,
} from "../backend/src/services/graph-merge/index.js";

async function proven(host: string, path: string, freshness: number): Promise<Contribution> {
  const delta = await signDelta({
    op: "add",
    endpoint: `GET ${host}${path}`,
    shape: shapePointer({ method: "GET", host, path, paramKeys: ["page"] }),
    freshness,
  });
  const validity = proveDeltaValidity(delta, 3, 16);
  const attestation = await attestExecution({ origin: `https://${host}`, method: "GET", shapeHash: delta.shape });
  return { delta, validity, attestation };
}

describe("graph-merge (plan node 4)", () => {
  it("a fully-proven contribution is admitted and changes the root", async () => {
    const g = emptyGraph();
    const before = graphRoot(g);
    const c = await proven("api.example.com", "/v1/items", 1000);
    expect(mergeDelta(g, c).admitted).toBe(true);
    expect(graphRoot(g)).not.toBe(before);
    expect(g.winners.size).toBe(1);
  });

  it("an unproven contribution (bad validity proof) is rejected; graph unchanged", async () => {
    const g = emptyGraph();
    const good = await proven("api.example.com", "/v1/items", 1000);
    const other = await proven("api.example.com", "/v1/other", 1000);
    const forged: Contribution = { ...good, validity: other.validity }; // proof for a different delta
    const res = mergeDelta(g, forged);
    expect(res.admitted).toBe(false);
    expect(res.reason).toBe("bad-validity-proof");
    expect(g.winners.size).toBe(0);
  });

  it("an unattested / mis-bound contribution is rejected", async () => {
    const g = emptyGraph();
    const c = await proven("api.example.com", "/v1/items", 1000);
    const wrongOrigin = await attestExecution({ origin: "https://api.evil.com", method: "GET", shapeHash: c.delta.shape });
    expect(mergeDelta(g, { ...c, attestation: wrongOrigin }).reason).toBe("attestation-unbound");
    // a tampered attestation signature fails the verify outright
    const tampered = { ...c.attestation, sig: (BigInt("0x" + c.attestation.sig) ^ 1n).toString(16) };
    expect(mergeDelta(g, { ...c, attestation: tampered }).reason).toBe("bad-attestation");
    expect(g.winners.size).toBe(0);
  });

  it("LWW: a fresher delta wins, a staler one is rejected as stale", async () => {
    const g = emptyGraph();
    const older = await proven("api.example.com", "/v1/items", 1000);
    const newer = await proven("api.example.com", "/v1/items", 2000);
    expect(mergeDelta(g, older).admitted).toBe(true);
    expect(mergeDelta(g, newer).admitted).toBe(true);          // fresher overwrites
    expect(g.winners.get("GET api.example.com/v1/items")!.freshness).toBe(2000);
    expect(mergeDelta(g, older).reason).toBe("stale");          // staler no longer wins
  });

  it("is convergent: two agents, different merge orders, same root (two witnesses)", async () => {
    const a = await proven("api.a.com", "/x", 1000);
    const b = await proven("api.b.com", "/y", 1000);
    const conflict1 = await proven("api.c.com", "/z", 1000);
    const conflict2 = await proven("api.c.com", "/z", 3000); // same endpoint, fresher → must win in both
    const all = [a, b, conflict1, conflict2];

    const g1 = emptyGraph();
    for (const c of all) mergeDelta(g1, c);            // order: a,b,c1,c2
    const g2 = emptyGraph();
    for (const c of [conflict2, conflict1, b, a]) mergeDelta(g2, c); // reversed
    const g3 = emptyGraph();
    for (const c of [b, conflict1, a, conflict2]) mergeDelta(g3, c); // shuffled

    expect(graphRoot(g1)).toBe(graphRoot(g2));
    expect(graphRoot(g1)).toBe(graphRoot(g3));
    expect(g1.winners.get("GET api.c.com/z")!.freshness).toBe(3000); // LWW winner is order-independent
  });
});
