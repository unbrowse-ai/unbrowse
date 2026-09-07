// Contract 8b2f65ea — semantic search must not return [] just because
// EmergentDB's /graph/search returns metadata-less results.
//
// Pre-fix: /v1/search on prod returned `{"results":[]}` for every query.
// Root cause: EmergentDB /graph/search returns only `{id, score}` per result
// (no `metadata` field, even with `include_metadata: true`). The backend's
// `rescoreWithComposite` then called `extractMeta(r.metadata)` and
// `r.metadata.source_url` on undefined `metadata`, throwing TypeError. The
// /v1/search route's try/catch swallowed the error and returned [].
//
// Fix: defensive metadata normalization in rescoreWithComposite +
// resultDomain, AND BM25 fallback in searchIntent (mirroring
// searchIntentInDomain).

import { describe, expect, it } from "bun:test";
import {
  rescoreWithComposite,
  bm25Score,
  rrfFuse,
  type Bm25Doc,
} from "../src/services/discovery.js";

describe("contract 8b2f65ea — search resilient to metadata-less graph results", () => {
  it("rescoreWithComposite does not crash when metadata is missing entirely", () => {
    // Shape EmergentDB actually returns:
    const metaLess = [
      { id: 12721, score: 0.74028105 },
      { id: 12748, score: 0.72 },
    ] as unknown as Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
    // Pre-fix: throws TypeError on r.metadata.source_url.
    expect(() => rescoreWithComposite(metaLess)).not.toThrow();
    const out = rescoreWithComposite(metaLess);
    expect(out.length).toBe(2);
    // Defensive normalization attaches an empty metadata object so downstream
    // filters (resultDomain, isMarketplaceDomainSuppressed) don't crash.
    expect(out[0].metadata).toBeDefined();
    expect(typeof out[0].metadata).toBe("object");
  });

  it("rescoreWithComposite still rescores when metadata IS present (no regression)", () => {
    const richMeta = [
      {
        id: 1,
        score: 0.7,
        metadata: {
          source_url: "linkedin.com",
          content: JSON.stringify({ avg_reliability: 0.9, verified_ratio: 1, updated_at: new Date().toISOString() }),
        },
      },
    ];
    const out = rescoreWithComposite(richMeta);
    expect(out.length).toBe(1);
    expect(out[0].metadata.source_url).toBe("linkedin.com");
  });

  it("rrfFuse(graphResults metadata-less, bm25Results with metadata) preserves the bm25 identity", () => {
    // Graph search: id-only.
    const graph = [
      { id: 12721, score: 0.74 },
      { id: 12748, score: 0.72 },
    ] as unknown as Array<{ id: number; score: number; metadata: Record<string, unknown> }>;
    // BM25 over docs we wrote at index time: carries metadata.
    const docs: Bm25Doc[] = [
      { id: "skillA:ep1", text: "linkedin people search", metadata: { source_url: "linkedin.com", content: JSON.stringify({ domain: "linkedin.com" }) } },
      { id: "skillB:ep2", text: "github trending", metadata: { source_url: "github.com", content: JSON.stringify({ domain: "github.com" }) } },
    ];
    const bm25 = bm25Score(docs, "linkedin people", 5);
    expect(bm25.length).toBeGreaterThan(0);

    const fused = rrfFuse(graph, bm25, 5);
    // At least the bm25 hit (with metadata) must survive the fuse.
    const bmIds = new Set(bm25.map((b) => b.id));
    const fusedBmHits = fused.filter((f) => bmIds.has(f.id));
    expect(fusedBmHits.length).toBeGreaterThan(0);
    // Identity (skill_id) reachable from metadata.content on the bm25 hit.
    const m = fusedBmHits[0].metadata as { content?: string };
    expect(typeof m.content).toBe("string");
  });
});
