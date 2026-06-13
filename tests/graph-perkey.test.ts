/**
 * graph-perkey.test — the witness for plan node 1 (per-endpoint store).
 * Proves: each winner / ledger record is its own small key (well under EmergentDB's ~10KB
 * cap); loadGraph reconstructs the whole graph by enumerating winner keys via list; a single
 * winner loads with one get; and the ledger is per-record and reloads in seq order.
 */
import { describe, expect, it } from "bun:test";
import {
  WINNER_PREFIX, LEDGER_PREFIX, winnerKey,
  saveWinner, loadWinner, loadGraph, saveGraph,
  appendLedgerRecord, loadLedger, ledgerNextSeq, type GraphKV,
} from "../backend/src/services/graph-store.js";
import { signDelta, shapePointer } from "../src/values/route-delta.js";
import { emptyGraph } from "../backend/src/services/graph-merge/index.js";

class FakeKV implements GraphKV {
  store = new Map<string, string>();
  async get(k: string, _t: "json"): Promise<unknown> { const v = this.store.get(k); return v ? JSON.parse(v) : null; }
  async put(k: string, v: string): Promise<void> { this.store.set(k, v); }
  async list(prefix: string): Promise<string[]> { return [...this.store.keys()].filter((k) => k.startsWith(prefix)); }
}

async function mk(endpoint: string) {
  return signDelta({ op: "add", endpoint, shape: shapePointer({ endpoint }), freshness: 1000 });
}

const EPS = ["GET a.com/x", "GET b.com/y", "GET c.com/z"];

describe("graph per-endpoint store (plan node 1)", () => {
  it("stores one small key per winner; loadGraph reconstructs via list", async () => {
    const kv = new FakeKV();
    for (const e of EPS) await saveWinner(kv, await mk(e));
    const winnerKeys = [...kv.store.keys()].filter((k) => k.startsWith(WINNER_PREFIX));
    expect(winnerKeys.length).toBe(3);
    for (const k of winnerKeys) expect(kv.store.get(k)!.length).toBeLessThan(10_240); // under the qdkv cap
    const g = await loadGraph(kv);
    expect(g.winners.size).toBe(3);
    expect(g.winners.get("GET a.com/x")!.endpoint).toBe("GET a.com/x");
  });

  it("a single winner loads with one get under its own key", async () => {
    const kv = new FakeKV();
    await saveWinner(kv, await mk("GET a.com/x"));
    expect(kv.store.has(winnerKey("GET a.com/x"))).toBe(true);
    expect((await loadWinner(kv, "GET a.com/x"))!.endpoint).toBe("GET a.com/x");
    expect(await loadWinner(kv, "GET nope.com/z")).toBeNull();
  });

  it("the ledger is per-record and reloads in seq order", async () => {
    const kv = new FakeKV();
    await appendLedgerRecord(kv, { deltaId: "b", endpoint: EPS[1], contributor: "w", freshness: 1, seq: 1 });
    await appendLedgerRecord(kv, { deltaId: "a", endpoint: EPS[0], contributor: "w", freshness: 1, seq: 0 });
    const ledgerKeys = [...kv.store.keys()].filter((k) => k.startsWith(LEDGER_PREFIX));
    expect(ledgerKeys.length).toBe(2);
    const led = await loadLedger(kv);
    expect(led.records.map((r) => r.seq)).toEqual([0, 1]); // ordered despite insert order
    expect(await ledgerNextSeq(kv)).toBe(2);
  });

  it("saveGraph compat writes every winner as its own key (no blob)", async () => {
    const kv = new FakeKV();
    const g = emptyGraph();
    for (const e of EPS) g.winners.set(e, await mk(e));
    await saveGraph(kv, g);
    expect([...kv.store.keys()].filter((k) => k.startsWith(WINNER_PREFIX)).length).toBe(3);
    expect([...kv.store.keys()].some((k) => k === "contrib:graph:v1")).toBe(false); // no single blob
  });
});
