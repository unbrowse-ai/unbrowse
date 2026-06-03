/**
 * semantic-cache.test — deterministic (mocked-fetch) lock on the L1/L2 tiering of
 * getOrComputeSemantic. The live witnesses (semantic-cache-*-witness.ts) prove it
 * against real EmergentDB but are network-flaky; this guards the logic in CI:
 *   - L1 exact hit returns WITHOUT embedding (the fast path),
 *   - a miss computes once and DEFERS the write-through (populating L1),
 *   - L2 fuzzy hit returns the vector-keyed payload (embedding IS used).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getOrComputeSemantic, clearSemanticL0 } from "../src/services/semantic-cache.js";

const originalFetch = globalThis.fetch;

// Mock-state knobs reset per test.
let l1Value: string | null;          // value qdkv returns for exact:* keys
let l2Value: string | null;          // value qdkv returns for veccache:* keys
let searchResults: { id: number; score: number }[];
let embedCalls: number;
let setKeys: string[];               // keys written via qdkv/set
let insertCalls: number;
let fetchCount: number;              // total network calls (to prove L0 makes ZERO)

function installMockFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCount++;
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    if (url.includes("/embeddings")) {
      embedCalls++;
      return json({ data: [{ embedding: Array(1536).fill(0.01) }] });
    }
    // Lookup search uses searchResults; after a vectorInsert (write-back), the
    // just-inserted vector becomes findable so the cache can learn its id.
    if (url.includes("/vectors/search")) return json({ results: insertCalls > 0 ? [{ id: 99, score: 1 }] : searchResults });
    if (url.includes("/vectors/insert")) { insertCalls++; return json({ success: true }); }
    if (url.includes("/qdkv/set")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key?: string };
      if (body.key) setKeys.push(body.key);
      return json({ ok: true });
    }
    if (url.includes("/qdkv/get/")) {
      const key = decodeURIComponent(url.split("/qdkv/get/")[1] ?? "");
      const v = key.startsWith("exact:") ? l1Value : key.startsWith("veccache:") ? l2Value : null;
      return json({ value: v, found: v != null });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const env = { EMERGENTDB_API_KEY: "test", NEBIUS_API_KEY: "test" };

beforeEach(() => {
  l1Value = null; l2Value = null; searchResults = []; embedCalls = 0; setKeys = []; insertCalls = 0; fetchCount = 0;
  clearSemanticL0();   // L0 is module-level — reset it so tests don't bleed into each other
  installMockFetch();
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe("semantic-cache tiering", () => {
  it("L1 exact hit returns without embedding", async () => {
    l1Value = JSON.stringify(["cached-exact"]);
    let computed = false;
    const r = await getOrComputeSemantic(env, "web", "the same query", async () => { computed = true; return ["fresh"]; });
    expect(r.cached).toBe(true);
    expect(r.value).toEqual(["cached-exact"]);
    expect(computed).toBe(false);
    expect(embedCalls).toBe(0); // the whole point: L1 skips the ~2s embed
  });

  it("a miss computes once and DEFERS the write-through (populating L1)", async () => {
    const writes: Promise<unknown>[] = [];
    let computeCount = 0;
    const r = await getOrComputeSemantic(
      env, "web", "a novel query",
      async () => { computeCount++; return ["computed"]; },
      (p) => writes.push(p),
    );
    expect(r.cached).toBe(false);
    expect(r.value).toEqual(["computed"]);
    expect(computeCount).toBe(1);
    // The write-through was handed to waitUntil rather than awaited inline — had it
    // been awaited, it would never reach the `writes` array (length would be 0).
    expect(writes.length).toBe(1);
    await Promise.all(writes);               // now let the deferred write finish
    expect(setKeys.some((k) => k.startsWith("exact:"))).toBe(true);     // L1 populated
    expect(setKeys.some((k) => k.startsWith("veccache:"))).toBe(true);  // L2 populated
  });

  it("L2 fuzzy hit returns the vector-keyed payload (embedding used)", async () => {
    searchResults = [{ id: 7, score: 0.9 }];   // >= 0.80 threshold
    l2Value = JSON.stringify(["cached-fuzzy"]);
    let computed = false;
    const r = await getOrComputeSemantic(env, "web", "a reworded query", async () => { computed = true; return ["fresh"]; });
    expect(r.cached).toBe(true);
    expect(r.value).toEqual(["cached-fuzzy"]);
    expect(computed).toBe(false);
    expect(embedCalls).toBe(1); // L2 needed the embedding
  });

  it("below-threshold vector match falls through to compute", async () => {
    searchResults = [{ id: 7, score: 0.5 }];   // < 0.80 → not a hit
    const r = await getOrComputeSemantic(env, "web", "a loosely related query", async () => ["computed"]);
    expect(r.cached).toBe(false);
    expect(r.value).toEqual(["computed"]);
  });

  it("L0 in-process hit serves a repeat with ZERO network calls", async () => {
    // 1st call: a miss — pays the network (embed/search/get); populates L0. Drain
    // the deferred write-through so the fetch count is stable before we measure.
    const writes: Promise<unknown>[] = [];
    await getOrComputeSemantic(env, "web", "a hot repeated query", async () => ["v"], (p) => writes.push(p));
    await Promise.all(writes);
    const afterFirst = fetchCount;
    expect(afterFirst).toBeGreaterThan(0);
    // 2nd identical call within the isolate: L0 hit — no EmergentDB/Nebius at all.
    const r = await getOrComputeSemantic(env, "web", "a hot repeated query", async () => ["should-not-run"]);
    expect(r.cached).toBe(true);
    expect(r.value).toEqual(["v"]);
    expect(fetchCount).toBe(afterFirst);   // ZERO additional network calls
  });
});
