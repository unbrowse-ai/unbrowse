/**
 * contract-proxy witness — the website is a thin frontend + proxies to on-chain with kv/emergentdb/graph.
 * Load-bearing proof (no fabricated green): a layer hit serves WITHOUT touching the on-chain source;
 * layer precedence is kv→emergentdb→graph; a full miss fetches the ledger ONCE and back-fills so the
 * next call is muscle memory.
 */
import { describe, expect, it } from "bun:test";
import { contractProxy, type LedgerLayer } from "./contract-proxy";

function memLayer(name: string, seed: Record<string, unknown> = {}): LedgerLayer {
  const m = new Map<string, unknown>(Object.entries(seed));
  return {
    name,
    get: async (k) => (m.has(k) ? (m.get(k) as unknown) : null),
    put: async (k, v) => {
      m.set(k, v);
    },
  };
}

describe("contractProxy — thin frontend, proxies to on-chain with kv/emergentdb/graph on top", () => {
  it("RECALL: a KV hit serves WITHOUT touching the on-chain source", async () => {
    let sourceCalls = 0;
    const kv = memLayer("kv", { "user:1": { name: "lewis" } });
    const r = await contractProxy({
      intent: "user:1",
      layers: [kv, memLayer("emergentdb"), memLayer("graph")],
      source: async () => {
        sourceCalls++;
        return { name: "fallback" };
      },
    });
    expect(r.recalled).toBe(true);
    expect(r.layer).toBe("kv");
    expect(sourceCalls).toBe(0); // the on-chain source was NEVER hit
    expect(r.value).toEqual({ name: "lewis" });
  });

  it("LAYER PRECEDENCE: KV miss → emergentDB hit, still no on-chain", async () => {
    let sourceCalls = 0;
    const r = await contractProxy({
      intent: "k",
      layers: [memLayer("kv"), memLayer("emergentdb", { k: 7 }), memLayer("graph")],
      source: async () => {
        sourceCalls++;
        return -1;
      },
    });
    expect(r.layer).toBe("emergentdb");
    expect(sourceCalls).toBe(0);
  });

  it("ON-CHAIN SOURCE: a full miss fetches the ledger ONCE + back-fills KV → next call is muscle memory", async () => {
    let sourceCalls = 0;
    const kv = memLayer("kv");
    const layers = [kv, memLayer("emergentdb")];
    const r1 = await contractProxy({
      intent: "z",
      layers,
      source: async () => {
        sourceCalls++;
        return { v: 99 };
      },
    });
    expect(r1.recalled).toBe(false);
    expect(r1.layer).toBe("onchain");
    expect(sourceCalls).toBe(1);
    const r2 = await contractProxy({
      intent: "z",
      layers,
      source: async () => {
        sourceCalls++;
        return { v: 0 };
      },
    });
    expect(r2.recalled).toBe(true); // back-filled → recalled from KV
    expect(r2.layer).toBe("kv");
    expect(sourceCalls).toBe(1); // STILL 1 — the on-chain source did not fire again
  });

  it("carries the _contract verdict shape (shaped all the way through)", async () => {
    const r = await contractProxy({ intent: "x", layers: [memLayer("kv", { x: 1 })], source: async () => 0 });
    expect(typeof r._contract.terminal).toBe("boolean");
  });
});
