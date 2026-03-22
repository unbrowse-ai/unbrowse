import { describe, expect, it } from "bun:test";
import { buildLocalSearchResults, normalizeEmbedding, shouldBypassSearchCache, shouldSkipGlobalSearch } from "../src/services/discovery.js";

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

describe("shouldBypassSearchCache", () => {
  it("bypasses cache only for the staging eval token on staging", () => {
    expect(shouldBypassSearchCache({ ENVIRONMENT: "staging" }, "Bearer staging-eval")).toBe(true);
    expect(shouldBypassSearchCache({ ENVIRONMENT: "staging" }, "Bearer some-other-token")).toBe(false);
    expect(shouldBypassSearchCache({ ENVIRONMENT: "production" }, "Bearer staging-eval")).toBe(false);
    expect(shouldBypassSearchCache({ ENVIRONMENT: "staging" }, undefined)).toBe(false);
  });
});

describe("buildLocalSearchResults", () => {
  const skills = [
    {
      skill_id: "alpha-docs-skill",
      version: "1.0.0",
      schema_version: "1",
      name: "docs.alpha-eval.com",
      intent_signature: "docs.alpha-eval.com",
      domain: "docs.alpha-eval.com",
      description: "ALPHADOCS docs search",
      owner_type: "agent",
      execution_type: "http",
      lifecycle: "active",
      created_at: "2026-03-21T00:00:00Z",
      updated_at: "2026-03-21T00:00:00Z",
      endpoints: [
        {
          endpoint_id: "alpha-doc-search",
          description: "ALPHADOCS developer documentation search for auth guide reference",
          method: "GET",
          url_template: "https://docs.alpha-eval.com/api/search?q={query}",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.98,
        },
      ],
    },
    {
      skill_id: "gamma-market-skill",
      version: "1.0.0",
      schema_version: "1",
      name: "quotes.gamma-eval.com",
      intent_signature: "quotes.gamma-eval.com",
      domain: "quotes.gamma-eval.com",
      description: "VXGAMMA quote and chart data",
      owner_type: "agent",
      execution_type: "http",
      lifecycle: "active",
      created_at: "2026-03-21T00:00:00Z",
      updated_at: "2026-03-21T00:00:00Z",
      endpoints: [
        {
          endpoint_id: "gamma-stock-quote",
          description: "VXGAMMA realtime quote snapshot for ticker symbol",
          method: "GET",
          url_template: "https://quotes.gamma-eval.com/api/quote?symbol={symbol}",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.98,
        },
        {
          endpoint_id: "gamma-chart-history",
          description: "VXGAMMA historical candle chart OHLC time series",
          method: "GET",
          url_template: "https://quotes.gamma-eval.com/api/chart?symbol={symbol}&range={range}",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.96,
        },
      ],
    },
  ];

  it("ranks the best local endpoint match first when graph metadata is missing", () => {
    const results = buildLocalSearchResults(skills as any, "get VXGAMMA realtime quote snapshot for a ticker", 3);
    expect(results[0]?.metadata?.skill_id).toBe("gamma-market-skill");
    expect(JSON.parse(String(results[0]?.metadata?.content)).endpoint_id).toBe("gamma-stock-quote");
  });

  it("keeps domain-scoped fallback inside the requested domain", () => {
    const results = buildLocalSearchResults(
      skills as any,
      "search ALPHADOCS developer documentation for auth guide",
      5,
      "docs.alpha-eval.com",
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((entry) => entry.metadata.domain === "docs.alpha-eval.com")).toBe(true);
  });
});
