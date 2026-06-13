/**
 * graph-store-dedicated.test — the witness for plan node 1 (dedicated graph KV).
 * Proves: resolveGraphKV prefers a dedicated GRAPH_KV (isolated from analytics), falls back
 * to STATS_KV under the `contrib:` prefix, and honest-nulls when neither is bound; the store
 * round-trips through the dedicated namespace; and a graph in GRAPH_KV does not collide with
 * STATS_KV (full isolation) while the fallback keys stay `contrib:`-prefixed (key isolation).
 */
import { describe, expect, it } from "bun:test";
import {
  resolveGraphKV, loadGraph, saveGraph, loadLedger, saveLedger,
  GRAPH_KEY, LEDGER_KEY, type GraphKV,
} from "../backend/src/services/graph-store.js";
import { emptyGraph } from "../backend/src/services/graph-merge/index.js";
import { emptyLedger } from "../backend/src/routes/contribution.js";
import { signDelta, shapePointer } from "../src/values/route-delta.js";

class FakeKV implements GraphKV {
  store = new Map<string, string>();
  async get(key: string, _type: "json"): Promise<unknown> {
    const v = this.store.get(key);
    return v ? JSON.parse(v) : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

async function aDelta(endpoint = "GET api.example.com/v1/items") {
  return signDelta({ op: "add", endpoint, shape: shapePointer({ endpoint }), freshness: 1000 });
}

describe("graph-store dedicated KV (plan node 1)", () => {
  it("prefers a dedicated GRAPH_KV when bound", () => {
    const GRAPH_KV = new FakeKV(), STATS_KV = new FakeKV();
    const r = resolveGraphKV({ GRAPH_KV, STATS_KV });
    expect(r.dedicated).toBe(true);
    expect(r.kv).toBe(GRAPH_KV);
  });

  it("falls back to STATS_KV (prefix-isolated) when no dedicated binding", () => {
    const STATS_KV = new FakeKV();
    const r = resolveGraphKV({ STATS_KV });
    expect(r.dedicated).toBe(false);
    expect(r.kv).toBe(STATS_KV);
  });

  it("honest-nulls when neither namespace is bound", () => {
    const r = resolveGraphKV({});
    expect(r.kv).toBeNull();
    expect(r.dedicated).toBe(false);
  });

  it("round-trips winners + ledger through the resolved store", async () => {
    const kv = resolveGraphKV({ GRAPH_KV: new FakeKV() }).kv!;
    const g = emptyGraph();
    g.winners.set("GET api.example.com/v1/items", await aDelta());
    await saveGraph(kv, g);
    const ledger = emptyLedger();
    ledger.records.push({ deltaId: "abc", endpoint: "GET api.example.com/v1/items", contributor: "w", freshness: 1000, seq: 0 });
    await saveLedger(kv, ledger);

    const g2 = await loadGraph(kv);
    const l2 = await loadLedger(kv);
    expect(g2.winners.size).toBe(1);
    expect(g2.winners.get("GET api.example.com/v1/items")!.endpoint).toBe("GET api.example.com/v1/items");
    expect(l2.records.length).toBe(1);
  });

  it("uses contrib:-prefixed keys and a dedicated graph does not collide with STATS_KV", async () => {
    const GRAPH_KV = new FakeKV(), STATS_KV = new FakeKV();
    const kv = resolveGraphKV({ GRAPH_KV, STATS_KV }).kv!; // dedicated chosen
    const g = emptyGraph();
    g.winners.set("GET api.example.com/v1/items", await aDelta());
    await saveGraph(kv, g);

    expect([...GRAPH_KV.store.keys()]).toContain(GRAPH_KEY);
    expect(GRAPH_KEY.startsWith("contrib:")).toBe(true);
    expect(LEDGER_KEY.startsWith("contrib:")).toBe(true);
    expect(STATS_KV.store.size).toBe(0); // analytics namespace untouched — full isolation
  });
});
