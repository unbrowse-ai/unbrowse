/**
 * Witness: the content-addressed embedding cache (the worst uncached recompute on
 * the web-search hot path). embed(query) is a ~2s model call but a pure function of
 * the query, so embedCached must serve repeats from L0 (in-isolate) and qdkv
 * (EmergentKV, cross-isolate) WITHOUT re-embedding.
 *   bun test backend/tests/embedding-cache.test.ts
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { embedCached, clearSemanticL0 } from "../src/services/semantic-cache.js";

const NEBIUS = "https://api.tokenfactory.nebius.com/v1/embeddings";
const EDB = "https://api.emergentdb.com";
const DIMS = 1536;
const VEC = Array.from({ length: DIMS }, (_, i) => (i % 7) / 10);

let embedCalls = 0;
const store = new Map<string, string>();
const realFetch = globalThis.fetch;

const mockFetch = (async (url: string, opts?: { body?: string }) => {
  const u = String(url);
  if (u === NEBIUS) {
    embedCalls++;
    // Real model latency (~2s) — modeled here so concurrent identical queries
    // genuinely OVERLAP (the thundering herd), not serialize by luck.
    await new Promise((r) => setTimeout(r, 30));
    return new Response(JSON.stringify({ data: [{ embedding: VEC }] }), { status: 200 });
  }
  if (u.startsWith(`${EDB}/qdkv/get/`)) {
    const key = decodeURIComponent(u.slice(`${EDB}/qdkv/get/`.length));
    const v = store.get(key);
    return new Response(JSON.stringify(v != null ? { found: true, value: v } : { found: false, value: null }), { status: 200 });
  }
  if (u === `${EDB}/qdkv/set`) {
    const body = JSON.parse(String(opts?.body ?? "{}")) as { key: string; value: string };
    store.set(body.key, body.value);
    return new Response("{}", { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

describe("embedding cache (content-addressed, no recompute)", () => {
  beforeEach(() => { embedCalls = 0; store.clear(); clearSemanticL0(); globalThis.fetch = mockFetch; });
  afterAll(() => { globalThis.fetch = realFetch; });

  it("L0: a repeated query embeds only ONCE (in-isolate cache)", async () => {
    await embedCached("retrieval augmented generation", "nk", "ek");
    await embedCached("retrieval augmented generation", "nk", "ek");
    expect(embedCalls).toBe(1);
  });

  it("qdkv: after L0 is dropped, a seen query is served from EmergentKV, NOT re-embedded", async () => {
    const v1 = await embedCached("postgres pool sizing", "nk", "ek"); // miss → embed + write-through
    await new Promise((r) => setTimeout(r, 25)); // let the fire-and-forget qdkvSet land
    clearSemanticL0(); // simulate a fresh isolate (no L0)
    const v2 = await embedCached("postgres pool sizing", "nk", "ek"); // served from qdkv
    expect(embedCalls).toBe(1); // NOT 2 — the ~2s embed was skipped
    expect(v2?.length).toBe(DIMS);
    expect(v2).toEqual(v1!);
  });

  it("distinct queries embed independently (no false cache hit)", async () => {
    await embedCached("aurora borealis cause", "nk", "ek");
    await embedCached("a totally different query", "nk", "ek");
    expect(embedCalls).toBe(2);
  });

  it("concurrency: N simultaneous identical queries embed only ONCE (single-flight)", async () => {
    const N = 10;
    await Promise.all(Array.from({ length: N }, () => embedCached("thundering herd query", "nk", "ek")));
    expect(embedCalls).toBe(1); // without single-flight, all N miss before the first write → N embeds
  });

  it("degraded: embed model returning null does not poison the cache", async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async (url: string, opts?: { body?: string }) => {
      if (String(url).endsWith("/v1/embeddings")) { embedCalls++; return new Response("nope", { status: 500 }); }
      return mockFetch(url, opts);
    }) as unknown as typeof fetch;
    const v = await embedCached("model is down", "nk", "ek");
    globalThis.fetch = saved;
    expect(v).toBeNull(); // honest null, not a cached bad value
  });
});
