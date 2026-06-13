/**
 * graph-emergentdb-routing.test — the witness for plan node 2 (EmergentDB-primary routing).
 * Proves: makeGraphKV chooses the EmergentDB-backed store when one is available, the dedicated
 * CF GRAPH_KV+STATS_KV fallback otherwise, shared STATS_KV alone, or none; and adaptKV
 * normalises a paginated CF/EdbKV-shaped list into a flat string[].
 */
import { describe, expect, it } from "bun:test";
import { makeGraphKV, adaptKV, type GraphKV, type RawListKV } from "../backend/src/services/graph-store.js";

/** A raw CF/EdbKV-shaped store: list returns {keys:[{name}]} and paginates 2 per page. */
class RawFake implements RawListKV {
  store = new Map<string, string>();
  async get(k: string, _t: "json"): Promise<unknown> { const v = this.store.get(k); return v ? JSON.parse(v) : null; }
  async put(k: string, v: string): Promise<void> { this.store.set(k, v); }
  async list(opts: { prefix: string; cursor?: string }) {
    const all = [...this.store.keys()].filter((k) => k.startsWith(opts.prefix));
    const off = opts.cursor ? parseInt(opts.cursor, 10) : 0;
    const page = all.slice(off, off + 2);
    const complete = off + 2 >= all.length;
    return { keys: page.map((name) => ({ name })), list_complete: complete, cursor: complete ? undefined : String(off + 2) };
  }
}

const fakeGraphKV = (): GraphKV => ({ get: async () => null, put: async () => {}, list: async () => [] });

describe("graph EmergentDB-primary routing (plan node 2)", () => {
  it("EmergentDB primary, CF wrap when CF present; bare EmergentDB when not", () => {
    const emergent = fakeGraphKV();
    const withCf = makeGraphKV({ GRAPH_KV: new RawFake(), STATS_KV: new RawFake() }, { emergent });
    expect(withCf.tier).toBe("emergentdb+cf"); // composed: EmergentDB primary, CF fallback/mirror
    const bare = makeGraphKV({}, { emergent });
    expect(bare.tier).toBe("emergentdb");
    expect(bare.kv).toBe(emergent);
  });

  it("degrades to CF when the EmergentDB primary errors (no 500)", async () => {
    const erroringEmergent: GraphKV = {
      get: async () => { throw new Error("emergentdb down"); },
      put: async () => { throw new Error("emergentdb down"); },
      list: async () => { throw new Error("emergentdb down"); },
    };
    const cf = new RawFake();
    await cf.put("contrib:w:k", JSON.stringify({ endpoint: "GET a.com/x" }));
    const { kv } = makeGraphKV({ GRAPH_KV: cf }, { emergent: erroringEmergent });
    // reads fall through to CF despite the primary throwing
    expect(await kv!.list("contrib:w:")).toEqual(["contrib:w:k"]);
    expect(await kv!.get("contrib:w:k", "json")).toEqual({ endpoint: "GET a.com/x" });
  });

  it("falls back to dedicated CF GRAPH_KV+STATS_KV when EmergentDB is absent", () => {
    const r = makeGraphKV({ GRAPH_KV: new RawFake(), STATS_KV: new RawFake() }, { emergent: null });
    expect(r.tier).toBe("dedicated-fallback");
    expect(r.kv).not.toBeNull();
  });

  it("uses shared STATS_KV alone, or none when nothing is bound", () => {
    expect(makeGraphKV({ STATS_KV: new RawFake() }, { emergent: null }).tier).toBe("shared");
    const none = makeGraphKV({}, { emergent: null });
    expect(none.tier).toBe("none");
    expect(none.kv).toBeNull();
  });

  it("adaptKV normalises a paginated list into a flat string[]", async () => {
    const raw = new RawFake();
    for (let i = 0; i < 5; i++) await raw.put(`contrib:w:k${i}`, JSON.stringify({ i }));
    await raw.put("other:z", "x"); // excluded by prefix
    const kv = adaptKV(raw);
    const keys = await kv.list("contrib:w:");
    expect(keys.length).toBe(5);                 // all 5 across 3 paginated pages
    expect(keys.every((k) => k.startsWith("contrib:w:"))).toBe(true);
    // get/put pass through
    await kv.put("contrib:w:k9", JSON.stringify({ v: 9 }));
    expect(await kv.get("contrib:w:k9", "json")).toEqual({ v: 9 });
  });
});
