/**
 * async-resolution.test — direct witness for the remote-tier core (src/values/async-resolution.ts):
 * content-addressing helpers, putBlobAsync/resolvePointerAsync, and resolveAsync's
 * hit/miss/ttl/eviction behaviour. Previously only exercised indirectly via the R2/IQ
 * adapters; this covers it on its own. Hermetic — in-memory store + ledger.
 */
import { describe, expect, it } from "bun:test";
import {
  contentPointer, intentKey, recordHash, GENESIS,
  putBlobAsync, resolvePointerAsync, resolveAsync,
  type AsyncBlobStore, type AsyncResolutionLedger,
} from "../src/values/async-resolution.js";
import type { ResolutionRecord } from "../src/values/resolution-ledger.js";

function memBlob(): AsyncBlobStore {
  const m = new Map<string, string>();
  return { get: async (h) => m.get(h), put: async (h, t) => void m.set(h, t) };
}
function memLedger(): AsyncResolutionLedger & { rows: ResolutionRecord[] } {
  const rows: ResolutionRecord[] = [];
  return {
    rows,
    find: async (intent) => [...rows].reverse().find((r) => r.intent === intent),
    history: async (intent) => rows.filter((r) => r.intent === intent),
    append: async (intent, result, ts) => {
      const seq = rows.length, prev = rows.length ? rows[rows.length - 1].hash : GENESIS;
      const rec: ResolutionRecord = { seq, intent, result, prev, hash: recordHash({ intent, prev, result, seq }), ts };
      rows.push(rec); return rec;
    },
  };
}

describe("async-resolution — content addressing", () => {
  it("contentPointer / intentKey are sha256: pointers, deterministic + distinct", () => {
    expect(contentPointer("x")).toBe(contentPointer("x"));
    expect(contentPointer("x")).not.toBe(contentPointer("y"));
    expect(contentPointer("x").startsWith("sha256:")).toBe(true);
    expect(intentKey("a")).toBe(intentKey("a"));
    expect(intentKey("a")).not.toBe(intentKey("b"));
    expect(intentKey("a")).not.toBe(contentPointer("a")); // namespaced separately
  });
  it("recordHash is deterministic over the signed core", () => {
    const a = recordHash({ intent: "i", prev: GENESIS, result: "sha256:ab", seq: 0 });
    expect(a).toBe(recordHash({ intent: "i", prev: GENESIS, result: "sha256:ab", seq: 0 }));
    expect(a).not.toBe(recordHash({ intent: "i", prev: GENESIS, result: "sha256:ab", seq: 1 }));
  });
});

describe("async-resolution — blob store", () => {
  it("putBlobAsync stores content-addressed; resolvePointerAsync round-trips; miss → null", async () => {
    const store = memBlob();
    const ptr = await putBlobAsync("hello", store);
    expect(ptr).toBe(contentPointer("hello"));        // pointer is hash of bytes
    expect(await resolvePointerAsync(ptr, store)).toBe("hello");
    expect(await resolvePointerAsync("sha256:deadbeef", store)).toBeNull(); // absent
  });
  it("non-content pointers resolve to their addr (wallet:/did:), unknown scheme → null", async () => {
    const store = memBlob();
    expect(await resolvePointerAsync("wallet:So1abc", store)).toBe("So1abc");
    expect(await resolvePointerAsync("did:key:z123", store)).toBe("key:z123");
    expect(await resolvePointerAsync("bogus", store)).toBeNull();
  });
});

describe("async-resolution — resolveAsync", () => {
  it("cold miss recomputes + stores + appends; warm hit replays with no recompute", async () => {
    const store = memBlob(), ledger = memLedger();
    let runs = 0;
    const recompute = async () => { runs++; return "result"; };
    const cold = await resolveAsync("intent", recompute, store, ledger);
    expect(cold.recomputed).toBe(true);
    expect(runs).toBe(1);
    expect(ledger.rows.length).toBe(1);
    const warm = await resolveAsync("intent", recompute, store, ledger);
    expect(warm.cached).toBe(true);
    expect(runs).toBe(1);                  // replayed, not recomputed
    expect(warm.value).toBe("result");
  });
  it("TTL-expired hit is refreshed (recomputed)", async () => {
    const store = memBlob(), ledger = memLedger();
    let runs = 0;
    const recompute = async () => { runs++; return `v${runs}`; };
    await resolveAsync("k", recompute, store, ledger, { ttlMs: 1000, now: 1_000_000 });
    const stale = await resolveAsync("k", recompute, store, ledger, { ttlMs: 1000, now: 1_005_000 });
    expect(stale.cached).toBe(false);
    expect(runs).toBe(2);
  });
  it("blob eviction recomputes the IDENTICAL pointer (docker rebuild)", async () => {
    const ledger = memLedger();
    const first = await resolveAsync("k", () => "LAYER", memBlob(), ledger);
    const rebuilt = await resolveAsync("k", () => "LAYER", memBlob(), ledger); // fresh (empty) store
    expect(rebuilt.pointer).toBe(first.pointer);
    expect(rebuilt.value).toBe("LAYER");
    expect(ledger.rows.length).toBe(1);    // no duplicate row
  });
});
