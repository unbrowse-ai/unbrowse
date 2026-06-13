/**
 * graph-perkey-route.test — the witness for plan node 3 (per-endpoint route merge).
 * Replicates the route's persistent flow (gateAndCompare + per-endpoint store writes) and
 * proves: an admitted contribution writes EXACTLY one winner key + one ledger key; a forged
 * one writes nothing; LWW holds (fresher overwrites the same endpoint, staler rejected); and
 * the root rebuilt from per-endpoint keys matches the in-memory graphRoot.
 */
import { describe, expect, it } from "bun:test";
import { signDelta, shapePointer, deltaId } from "../src/values/route-delta.js";
import { proveDeltaValidity } from "../src/values/delta-proof.js";
import { attestExecution } from "../src/capture/exec-attest.js";
import {
  emptyGraph, mergeDelta, graphRoot, gateAndCompare, type Contribution,
} from "../backend/src/services/graph-merge/index.js";
import {
  WINNER_PREFIX, LEDGER_PREFIX, loadWinner, saveWinner, appendLedgerRecord, ledgerNextSeq,
  loadGraph, type GraphKV,
} from "../backend/src/services/graph-store.js";

class FakeKV implements GraphKV {
  store = new Map<string, string>();
  async get(k: string, _t: "json"): Promise<unknown> { const v = this.store.get(k); return v ? JSON.parse(v) : null; }
  async put(k: string, v: string): Promise<void> { this.store.set(k, v); }
  async list(prefix: string): Promise<string[]> { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
  count(prefix: string): number { return [...this.store.keys()].filter((k) => k.startsWith(prefix)).length; }
}

async function proven(host: string, path: string, freshness: number): Promise<Contribution> {
  const delta = await signDelta({ op: "add", endpoint: `GET ${host}${path}`, shape: shapePointer({ host, path }), freshness });
  return {
    delta,
    validity: proveDeltaValidity(delta, 3, 16),
    attestation: await attestExecution({ origin: `https://${host}`, method: "GET", shapeHash: delta.shape }),
  };
}

/** The route's persistent per-endpoint flow. */
async function contribute(kv: GraphKV, c: Contribution) {
  const current = await loadWinner(kv, c.delta.endpoint);
  const result = gateAndCompare(current, c);
  if (!result.admitted) return result;
  await saveWinner(kv, c.delta);
  const seq = await ledgerNextSeq(kv);
  await appendLedgerRecord(kv, {
    deltaId: deltaId(c.delta), endpoint: c.delta.endpoint, contributor: c.delta.walletRoot, freshness: c.delta.freshness, seq,
  });
  return result;
}

describe("graph per-endpoint route merge (plan node 3)", () => {
  it("an admitted contribution writes exactly one winner key + one ledger key", async () => {
    const kv = new FakeKV();
    expect((await contribute(kv, await proven("api.example.com", "/v1/items", 1000))).admitted).toBe(true);
    expect(kv.count(WINNER_PREFIX)).toBe(1);
    expect(kv.count(LEDGER_PREFIX)).toBe(1);
  });

  it("a forged contribution writes nothing", async () => {
    const kv = new FakeKV();
    const c = await proven("api.example.com", "/v1/items", 1000);
    const forged: Contribution = { ...c, attestation: { ...c.attestation, origin: "https://api.evil.com" } };
    expect((await contribute(kv, forged)).admitted).toBe(false);
    expect(kv.count(WINNER_PREFIX)).toBe(0);
    expect(kv.count(LEDGER_PREFIX)).toBe(0);
  });

  it("LWW: a fresher contribution overwrites the same endpoint's single winner key; staler rejected", async () => {
    const kv = new FakeKV();
    await contribute(kv, await proven("api.example.com", "/v1/items", 1000));
    expect((await contribute(kv, await proven("api.example.com", "/v1/items", 2000))).admitted).toBe(true);
    expect(kv.count(WINNER_PREFIX)).toBe(1); // same endpoint ⇒ still one winner key
    expect((await loadWinner(kv, "GET api.example.com/v1/items"))!.freshness).toBe(2000);
    expect((await contribute(kv, await proven("api.example.com", "/v1/items", 500))).admitted).toBe(false); // staler
    expect((await loadWinner(kv, "GET api.example.com/v1/items"))!.freshness).toBe(2000);
  });

  it("the root rebuilt from per-endpoint keys matches the in-memory graphRoot", async () => {
    const kv = new FakeKV();
    const inMem = emptyGraph();
    const cs = [
      await proven("api.a.com", "/x", 1000),
      await proven("api.b.com", "/y", 1000),
      await proven("api.c.com", "/z", 3000),
    ];
    for (const c of cs) { await contribute(kv, c); mergeDelta(inMem, c); }
    const rebuilt = await loadGraph(kv);
    expect(graphRoot(rebuilt)).toBe(graphRoot(inMem));
    expect(rebuilt.winners.size).toBe(3);
  });
});
