/**
 * Tests for BM25 lexical search scoring and RRF fusion (Issue #155).
 */
import { describe, it, expect } from "bun:test";
import { tokenize, bm25Score, rrfFuse, type Bm25Doc } from "../src/services/discovery.js";

const docs: Bm25Doc[] = [
  { id: "s1:ep1", text: "GET /api/hotels/search hotel availability rates pricing", metadata: { method: "GET" } },
  { id: "s1:ep2", text: "POST /api/bookings create hotel reservation booking", metadata: { method: "POST" } },
  { id: "s2:ep1", text: "GET /api/flights/search flight availability pricing", metadata: { method: "GET" } },
  { id: "s2:ep2", text: "GET /api/weather current weather forecast temperature", metadata: { method: "GET" } },
  { id: "s3:ep1", text: "GET /api/hotels/reviews hotel guest reviews ratings", metadata: { method: "GET" } },
];

describe("tokenize", () => {
  it("lowercases and splits on word boundaries", () => {
    expect(tokenize("GET /api/Hotels")).toEqual(["get", "api", "hotels"]);
  });

  it("returns empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });

  it("handles punctuation-only input", () => {
    expect(tokenize("///...")).toEqual([]);
  });
});

describe("bm25Score", () => {
  it("returns empty for empty docs", () => {
    expect(bm25Score([], "hotel", 5)).toEqual([]);
  });

  it("returns empty for empty query", () => {
    expect(bm25Score(docs, "", 5)).toEqual([]);
  });

  it("ranks exact keyword matches highest", () => {
    const results = bm25Score(docs, "hotel", 5);
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => String(r.id));
    expect(ids).toContain("s1:ep1");
    expect(ids).toContain("s1:ep2");
    expect(ids).toContain("s3:ep1");
    expect(ids).not.toContain("s2:ep2");
  });

  it("multi-term query boosts docs matching more terms", () => {
    const results = bm25Score(docs, "hotel pricing", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(String(results[0].id)).toBe("s1:ep1");
  });

  it("respects k limit", () => {
    const results = bm25Score(docs, "hotel", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("scores are positive for matching docs", () => {
    const results = bm25Score(docs, "flight", 5);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("results are sorted by score descending", () => {
    const results = bm25Score(docs, "hotel availability", 5);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("rare terms get higher IDF weight", () => {
    const weatherResults = bm25Score(docs, "weather", 5);
    const hotelResults = bm25Score(docs, "hotel", 5);
    expect(weatherResults[0].score).toBeGreaterThan(hotelResults[0].score);
  });

  it("preserves metadata in results", () => {
    const results = bm25Score(docs, "flight", 5);
    expect(results[0].metadata).toEqual({ method: "GET" });
  });
});

describe("rrfFuse", () => {
  const listA = [
    { id: 1, score: 0.9, metadata: { src: "graph" } },
    { id: 2, score: 0.7, metadata: { src: "graph" } },
    { id: 3, score: 0.5, metadata: { src: "graph" } },
  ];
  const listB = [
    { id: 2, score: 0.8, metadata: { src: "bm25" } },
    { id: 4, score: 0.6, metadata: { src: "bm25" } },
    { id: 1, score: 0.4, metadata: { src: "bm25" } },
  ];

  it("items appearing in both lists get boosted", () => {
    const fused = rrfFuse(listA, listB, 10);
    const ids = fused.map((r) => String(r.id));
    expect(ids.indexOf("1")).toBeLessThan(ids.indexOf("3"));
    expect(ids.indexOf("2")).toBeLessThan(ids.indexOf("3"));
  });

  it("respects k limit", () => {
    const fused = rrfFuse(listA, listB, 2);
    expect(fused.length).toBe(2);
  });

  it("includes items only in one list", () => {
    const fused = rrfFuse(listA, listB, 10);
    const ids = fused.map((r) => String(r.id));
    expect(ids).toContain("3");
    expect(ids).toContain("4");
  });

  it("returns empty for two empty lists", () => {
    expect(rrfFuse([], [], 5)).toEqual([]);
  });

  it("handles one empty list gracefully", () => {
    const fused = rrfFuse(listA, [], 5);
    expect(fused.length).toBe(3);
  });

  it("RRF scores use 1/(K+rank+1) formula with K=60", () => {
    const fused = rrfFuse(
      [{ id: 10, score: 1, metadata: {} }],
      [{ id: 10, score: 1, metadata: {} }],
      5,
    );
    expect(fused[0].score).toBeCloseTo(2 / 61, 10);
  });

  it("results are sorted by fused score descending", () => {
    const fused = rrfFuse(listA, listB, 10);
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
  });
});
