/**
 * resolution-ledger.test — the witness for "signatures as kv cache to pointers that
 * resolve on truth resolution, recomputable like docker, a ledger of resolutions."
 *
 * Proves: an expensive resolution runs ONCE; the warm path resolves the pointer with
 * no recompute (the search-latency fix in primitive form); the value is content-
 * addressed (docker-layer dedup); the ledger of resolutions is append-only + hash-
 * chained; and a blob eviction recomputes the IDENTICAL layer (docker rebuild).
 */
import { describe, expect, it } from "bun:test";
import {
  resolve, intentPointer, putBlob, resolvePointer, memBlobStore, memLedger, verifyLedger,
} from "../src/values/resolution-ledger.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

describe("resolution-ledger", () => {
  it("the expensive resolution runs ONCE; the warm path replays the pointer (no recompute)", async () => {
    const store = memBlobStore(); const ledger = memLedger();
    let runs = 0;
    const recompute = async (intent: string) => { runs++; await sleep(100); return `result:${intent}`; };

    const t0 = now();
    const cold = await resolve("buy milk", recompute, store, ledger);
    const coldMs = now() - t0;
    expect(cold.recomputed).toBe(true);
    expect(cold.cached).toBe(false);
    expect(runs).toBe(1);

    const t1 = now();
    const warm = await resolve("buy milk", recompute, store, ledger);
    const warmMs = now() - t1;
    expect(warm.cached).toBe(true);
    expect(warm.recomputed).toBe(false);
    expect(warm.value).toBe("result:buy milk");
    expect(runs).toBe(1);                       // recompute NOT called again — the fix
    expect(warmMs * 20).toBeLessThan(coldMs);   // warm categorically faster (pointer resolve vs recompute)
  });

  it("the value is content-addressed — the result pointer is sha256(value) (docker dedup)", async () => {
    const store = memBlobStore(); const ledger = memLedger();
    const r = await resolve("q", () => "VALUE", store, ledger);
    expect(r.pointer).toBe(putBlob("VALUE", memBlobStore())); // same bytes → same pointer
    expect(r.pointer.startsWith("sha256:")).toBe(true);
    expect(resolvePointer(r.pointer, store)).toBe("VALUE");   // resolves back to the value
  });

  it("distinct intents get distinct keys; identical intents collide on the same key", () => {
    expect(intentPointer("a")).toBe(intentPointer("a"));
    expect(intentPointer("a")).not.toBe(intentPointer("b"));
  });

  it("the ledger of resolutions is append-only + hash-chained (tamper-evident)", async () => {
    const store = memBlobStore(); const ledger = memLedger();
    await resolve("one", () => "1", store, ledger);
    await resolve("two", () => "2", store, ledger);
    await resolve("three", () => "3", store, ledger);
    expect(ledger.rows().length).toBe(3);
    expect(verifyLedger(ledger)).toBe(true);
    // tamper a row's result pointer → chain no longer verifies
    ledger.rows()[1].result = "sha256:deadbeef";
    expect(verifyLedger(ledger)).toBe(false);
  });

  it("blob eviction recomputes the IDENTICAL layer (docker rebuild, same pointer)", async () => {
    const store = memBlobStore(); const ledger = memLedger();
    const first = await resolve("rebuild me", () => "LAYER", store, ledger);
    // evict the blob layer but keep the ledger memory of the resolution
    const evicted = memBlobStore();
    const rebuilt = await resolve("rebuild me", () => "LAYER", evicted, ledger);
    expect(rebuilt.pointer).toBe(first.pointer);     // identical content address
    expect(rebuilt.value).toBe("LAYER");
    expect(ledger.rows().length).toBe(1);            // no duplicate resolution row appended
  });
});
