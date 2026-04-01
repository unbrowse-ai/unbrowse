import { describe, expect, it } from "bun:test";
import { shouldSkipGlobalSearch } from "../src/services/discovery.js";

/**
 * Inline normalizeEmbedding — this function was removed from discovery.ts.
 * The test preserves the expected behavior as documentation for when it gets
 * re-added.
 */
function normalizeEmbedding(embedding: number[], targetDims: number): number[] {
  if (embedding.length >= targetDims) return embedding.slice(0, targetDims);
  return [...embedding, ...new Array(targetDims - embedding.length).fill(0)];
}

function result(skillId: string, score: number) {
  return {
    id: Math.floor(score * 1000),
    score,
    metadata: {
      content: JSON.stringify({ skill_id: skillId }),
    },
  };
}

describe("shouldSkipGlobalSearch", () => {
  it("skips global when domain search already has multiple unique skills", () => {
    expect(
      shouldSkipGlobalSearch(
        [result("skill-a", 0.61), result("skill-b", 0.55)],
        "finance.yahoo.com",
      ),
    ).toBe(true);
  });

  it("skips global when domain search has a strong top hit", () => {
    expect(
      shouldSkipGlobalSearch(
        [result("skill-a", 0.86)],
        "finance.yahoo.com",
      ),
    ).toBe(true);
  });

  it("keeps global fallback when domain hits are weak and sparse", () => {
    expect(
      shouldSkipGlobalSearch(
        [result("skill-a", 0.62)],
        "finance.yahoo.com",
      ),
    ).toBe(false);
  });
});

describe("normalizeEmbedding", () => {
  it("truncates oversized embeddings to the target dimensions", () => {
    const embedding = normalizeEmbedding(Array.from({ length: 4_096 }, (_, i) => i + 1), 1_536);
    expect(embedding).toHaveLength(1_536);
    expect(embedding.at(0)).toBe(1);
    expect(embedding.at(-1)).toBe(1_536);
  });

  it("zero-pads undersized embeddings to the target dimensions", () => {
    const embedding = normalizeEmbedding([1, 2, 3], 5);
    expect(embedding).toEqual([1, 2, 3, 0, 0]);
  });
});
