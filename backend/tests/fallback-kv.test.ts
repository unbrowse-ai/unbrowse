import { test, expect } from "bun:test";
import { FallbackKV } from "../src/services/kv";

// Witness for the kv-fallback-pipe: EmergentDB primary + Cloudflare KV fallback.
// The load-bearing claim — a degraded/down EmergentDB must NOT lose writes or
// fail reads, because the worker can always reach Cloudflare KV.

function fakeCf() {
  const m = new Map<string, string>();
  return {
    store: m,
    get: async (k: string) => (m.has(k) ? m.get(k)! : null),
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    }),
  };
}

test("put survives a DOWN EmergentDB via the CF fallback (write not lost)", async () => {
  const down = { put: async () => { throw new Error("emergentdb down"); }, get: async () => { throw new Error("down"); } };
  const cf = fakeCf();
  const kv = new FallbackKV(down as never, cf as never, "stats");
  await kv.put("k1", "v1");                        // primary throws, CF accepts -> no throw
  expect(cf.store.get("stats:k1")).toBe("v1");     // namespace-prefixed in CF
  expect(await kv.get("k1")).toBe("v1");           // get: primary throws -> CF hit
});

test("write-through mirrors to CF even when the primary works", async () => {
  const m = new Map<string, string>();
  const ok = { put: async (k: string, v: string) => { m.set(k, v); }, get: async (k: string) => m.get(k) ?? null };
  const cf = fakeCf();
  const kv = new FallbackKV(ok as never, cf as never, "stats");
  await kv.put("k2", "v2");
  expect(m.get("k2")).toBe("v2");                  // primary has it
  expect(cf.store.get("stats:k2")).toBe("v2");     // AND the CF mirror has it
  expect(await kv.get("k2")).toBe("v2");           // read from primary first
});

test("get falls back to CF on a primary MISS (value only in CF)", async () => {
  const miss = { get: async () => null, put: async () => {} };
  const cf = fakeCf(); cf.store.set("stats:k3", "v3");
  const kv = new FallbackKV(miss as never, cf as never, "stats");
  expect(await kv.get("k3")).toBe("v3");
});

test("put throws ONLY when BOTH stores fail (no silent loss)", async () => {
  const down = { put: async () => { throw new Error("down"); } };
  const cfDown = { put: async () => { throw new Error("cf down"); }, get: async () => null };
  const kv = new FallbackKV(down as never, cfDown as never, "stats");
  await expect(kv.put("k4", "v4")).rejects.toThrow(/both stores/);
});

test("listWithValues falls back to CF on a DEGRADED-EMPTY primary (no throw)", async () => {
  // The live-prod bug: a degraded EmergentDB returns [] WITHOUT erroring; the
  // write-through mirror in CF still has the data, so the read must use it.
  const degraded = { listWithValues: async () => [] }; // empty, no throw
  const cf = fakeCf();
  cf.store.set("stats:contract:abc:event:1", JSON.stringify({ e: 1 }));
  cf.store.set("stats:contract:abc:event:2", JSON.stringify({ e: 2 }));
  const kv = new FallbackKV(degraded as never, cf as never, "stats");
  const rows = await kv.listWithValues("contract:abc:event:");
  expect(rows.length).toBe(2);                       // recovered from CF, not the empty primary
  expect(rows.map((r) => r.name).sort()).toEqual(["contract:abc:event:1", "contract:abc:event:2"]);
});

test("list falls back to CF on a degraded-empty primary", async () => {
  const degraded = { list: async () => ({ keys: [], list_complete: true, cursor: undefined }) };
  const cf = fakeCf(); cf.store.set("stats:p:1", "a");
  const kv = new FallbackKV(degraded as never, cf as never, "stats");
  const r = await kv.list({ prefix: "p:" });
  expect(r.keys.map((k) => k.name)).toEqual(["p:1"]);
});

test("json round-trips through the CF fallback", async () => {
  const down = { get: async () => { throw new Error("down"); }, put: async () => { throw new Error("down"); } };
  const cf = fakeCf();
  const kv = new FallbackKV(down as never, cf as never, "stats");
  await kv.put("k5", JSON.stringify({ a: 1 }));
  expect(await kv.get("k5", "json")).toEqual({ a: 1 });
});
