/**
 * graph-store-fallback.test — GRAPH_KV primary with CF STATS_KV runtime fallback.
 * Proves: reads hit the primary first; on a primary miss OR a primary error they fall back to
 * CF KV; writes mirror to both so the fallback can serve after a primary outage; and
 * resolveGraphStore reports the right mode for each binding combination.
 */
import { describe, expect, it } from "bun:test";
import {
  FallbackGraphKV, resolveGraphStore, type GraphKV,
} from "../backend/src/services/graph-store.js";

class FakeKV implements GraphKV {
  store = new Map<string, string>();
  gets = 0; puts = 0;
  constructor(public throwOnGet = false, public throwOnPut = false) {}
  async get(key: string, _t: "json"): Promise<unknown> {
    this.gets++;
    if (this.throwOnGet) throw new Error("primary down");
    const v = this.store.get(key);
    return v ? JSON.parse(v) : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.puts++;
    if (this.throwOnPut) throw new Error("primary down");
    this.store.set(key, value);
  }
  async list(prefix: string): Promise<string[]> {
    if (this.throwOnGet) throw new Error("primary down");
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

describe("graph-store fallback (GRAPH_KV primary, CF KV fallback)", () => {
  it("reads the primary first and does not touch the fallback on a hit", async () => {
    const primary = new FakeKV(), fallback = new FakeKV();
    primary.store.set("k", JSON.stringify({ from: "primary" }));
    const kv = new FallbackGraphKV(primary, fallback);
    expect(await kv.get("k", "json")).toEqual({ from: "primary" });
    expect(fallback.gets).toBe(0); // primary hit → fallback untouched
  });

  it("falls back to CF KV on a primary MISS", async () => {
    const primary = new FakeKV(), fallback = new FakeKV();
    fallback.store.set("k", JSON.stringify({ from: "fallback" }));
    const kv = new FallbackGraphKV(primary, fallback);
    expect(await kv.get("k", "json")).toEqual({ from: "fallback" });
  });

  it("falls back to CF KV on a primary ERROR (outage resilience)", async () => {
    const primary = new FakeKV(true), fallback = new FakeKV(); // primary throws on get
    fallback.store.set("k", JSON.stringify({ from: "fallback" }));
    const kv = new FallbackGraphKV(primary, fallback);
    expect(await kv.get("k", "json")).toEqual({ from: "fallback" });
  });

  it("mirror-writes to both stores so the fallback can serve later", async () => {
    const primary = new FakeKV(), fallback = new FakeKV();
    const kv = new FallbackGraphKV(primary, fallback);
    await kv.put("k", JSON.stringify({ v: 1 }));
    expect(primary.store.get("k")).toBeDefined();
    expect(fallback.store.get("k")).toBeDefined(); // mirrored
  });

  it("a write survives a primary-put outage via the fallback mirror", async () => {
    const primary = new FakeKV(false, true), fallback = new FakeKV(); // primary throws on put
    const kv = new FallbackGraphKV(primary, fallback);
    await kv.put("k", JSON.stringify({ v: 2 })); // must not throw — fallback absorbed it
    expect(fallback.store.get("k")).toBeDefined();
  });

  it("resolveGraphStore reports the mode for each binding combination", () => {
    const A = new FakeKV(), B = new FakeKV();
    expect(resolveGraphStore({ GRAPH_KV: A, STATS_KV: B }).mode).toBe("fallback");
    expect(resolveGraphStore({ GRAPH_KV: A }).mode).toBe("dedicated");
    expect(resolveGraphStore({ STATS_KV: B }).mode).toBe("shared");
    expect(resolveGraphStore({}).mode).toBe("none");
    expect(resolveGraphStore({}).kv).toBeNull();
  });
});
