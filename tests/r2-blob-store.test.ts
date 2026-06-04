/**
 * r2-blob-store.test — the witness that the Cloudflare R2 KV-cache tier satisfies the
 * AsyncBlobStore contract and round-trips content-addressed values. Hermetic: a stub
 * S3-compatible client (a Map) stands in for R2, so the adapter is proven without
 * network. Also proves resolveAsync replays a cached pointer through the R2 store.
 */
import { describe, expect, it } from "bun:test";
import { r2BlobStore, r2ConfigFromEnv, type ObjectStoreClient } from "../src/values/r2-blob-store.js";
import { putBlobAsync, resolvePointerAsync, resolveAsync, type AsyncResolutionLedger } from "../src/values/async-resolution.js";
import type { ResolutionRecord } from "../src/values/resolution-ledger.js";

function stubR2(): ObjectStoreClient & { keys: () => string[] } {
  const m = new Map<string, string>();
  return {
    get: async (k) => (m.has(k) ? m.get(k)! : null),
    put: async (k, v) => void m.set(k, v),
    keys: () => [...m.keys()],
  };
}

// a trivial in-memory ledger so we can exercise resolveAsync against the R2 store
function memAsyncLedger(): AsyncResolutionLedger {
  const rows: ResolutionRecord[] = [];
  return {
    find: async (intent) => [...rows].reverse().find((r) => r.intent === intent),
    history: async (intent) => rows.filter((r) => r.intent === intent),
    append: async (intent, result, ts) => {
      const rec: ResolutionRecord = { seq: rows.length, intent, result, prev: "0", hash: "h", ts };
      rows.push(rec); return rec;
    },
  };
}

describe("r2-blob-store", () => {
  it("put then get round-trips; missing key is undefined; keys are namespaced", async () => {
    const client = stubR2();
    const store = r2BlobStore(client, "resolution/");
    await store.put("abc123", "the value");
    expect(await store.get("abc123")).toBe("the value");
    expect(await store.get("missing")).toBeUndefined();
    expect(client.keys()).toEqual(["resolution/abc123"]); // namespaced in the bucket
  });

  it("content-addressed: putBlobAsync returns a sha256 pointer that resolves back", async () => {
    const store = r2BlobStore(stubR2());
    const ptr = await putBlobAsync("hello world", store);
    expect(ptr.startsWith("sha256:")).toBe(true);
    expect(await resolvePointerAsync(ptr, store)).toBe("hello world");
    // same bytes → same pointer (docker-layer dedup), on any host
    expect(await putBlobAsync("hello world", r2BlobStore(stubR2()))).toBe(ptr);
  });

  it("resolveAsync replays the cached pointer from R2 without recomputing", async () => {
    const store = r2BlobStore(stubR2());
    const ledger = memAsyncLedger();
    let runs = 0;
    const recompute = async () => { runs++; return "expensive result"; };
    const cold = await resolveAsync("buy milk", recompute, store, ledger);
    expect(cold.recomputed).toBe(true); expect(runs).toBe(1);
    const warm = await resolveAsync("buy milk", recompute, store, ledger);
    expect(warm.cached).toBe(true); expect(runs).toBe(1); // R2 hit, no recompute
    expect(warm.value).toBe("expensive result");
  });

  it("r2ConfigFromEnv returns null without creds, a config with them", () => {
    expect(r2ConfigFromEnv({})).toBeNull();
    const cfg = r2ConfigFromEnv({
      R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s",
    });
    expect(cfg?.bucket).toBe("b");
  });
});
