import { describe, expect, test } from "bun:test";
import { embedderForIndexing } from "../src/values/contract-everything.js";
import { hashEmbedder, resolveLiveEmbedder } from "../src/values/contract-search.js";

/**
 * Witness for the "/contract has an embedded embedder" lever: the RAG/searchable
 * passive-index tier must NEVER silently skip for lack of an embedder. The substrate's
 * OWN embedded feature-hash embedder (no model, no server, no key — claim 55 dense_norm)
 * is the terminal 1536-dim fallback, fulfilling resolveLiveEmbedder's documented promise
 * "then the offline hashEmbedder bears the load" (Matt 5:17 — fulfil, not abolish).
 */
describe("embedded embedder fallback (no server, no key)", () => {
  test("hashEmbedder produces the exact 1536 dim the emergent store is locked to", async () => {
    const v = await hashEmbedder(1536).embed("captured route reddit posts");
    expect(v.length).toBe(1536);
    expect(v.some((x) => x > 0)).toBe(true); // real bag-of-words signal, not all-zero
  });

  test("embedderForIndexing NEVER returns null — embedded fallback bears the load when :8090 is down and no keys", async () => {
    // Force the semantic tiers absent: a closed embed port + no cloud keys.
    const env = {
      UNBROWSE_EMBED_URL: "http://127.0.0.1:1",
      OPENAI_API_KEY: undefined,
      NEBIUS_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
    } as Record<string, string | undefined>;

    // Contract preserved: resolveLiveEmbedder stays SEMANTIC-only (returns null here).
    const live = await resolveLiveEmbedder(env);
    expect(live).toBeNull();

    // The indexing seam, however, always yields a usable 1536-dim embedder.
    const chosen = await embedderForIndexing(env);
    expect(chosen.provider).toBe("embedded-hash-1536");
    const vec = await chosen.embed.embed("captured route reddit posts");
    expect(vec.length).toBe(1536);
  });
});
