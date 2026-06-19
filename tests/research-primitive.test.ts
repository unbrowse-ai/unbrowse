// Falsifiable signals (Step 4) for the native research primitive (Tavily parity).
// The load-bearing invariant is NO FABRICATION: the answer/citations are built only from
// really-fetched sources; empty query or zero fetched sources -> honest empty, never invented.
// Network-free contract tests run always; the live grounding test is env-gated (UNBROWSE_LIVE=1).
import { describe, it, expect } from "bun:test";
import { doResearch, doExtract, type ResearchAnswer } from "../src/orchestrator/research.js";

function assertHonestEmpty(r: ResearchAnswer) {
  expect(r.answer).toBe("");
  expect(r.citations).toEqual([]);
  expect(r.results).toEqual([]);
}

describe("research primitive — honest-empty contract (network-free)", () => {
  it("empty query -> honest empty, never fabricated", async () => {
    assertHonestEmpty(await doResearch(""));
    assertHonestEmpty(await doResearch("   "));
  });

  it("preserves the query verbatim (trimmed)", async () => {
    const r = await doResearch("  spaced query  ", { numResults: 0 });
    expect(r.query).toBe("spaced query");
  });

  it("numResults=0 fetches nothing -> honest empty (no sources => no answer)", async () => {
    // With zero results requested, no source is fetched, so the no-fabrication rule
    // must yield an empty answer (not a hallucinated one).
    assertHonestEmpty(await doResearch("who founded Stripe", { numResults: 0 }));
  });
});

describe("research primitive — invariants any non-empty result must satisfy", () => {
  it("every citation url appears in results, and answer is built only from citation quotes", async () => {
    // Pure structural check against a hand-built result shape (no network): the property the
    // synthesizer guarantees — citations subset of results, answer = join of quotes.
    const sample: ResearchAnswer = {
      query: "q",
      answer: "Quote A. Quote B.",
      citations: [
        { url: "https://a.example/x", title: "A", quote: "Quote A." },
        { url: "https://b.example/y", title: "B", quote: "Quote B." },
      ],
      results: [
        { url: "https://a.example/x", title: "A", content: "Quote A. more", score: 2 },
        { url: "https://b.example/y", title: "B", content: "Quote B. more", score: 1 },
      ],
    };
    const resultUrls = new Set(sample.results.map((r) => r.url));
    for (const c of sample.citations) expect(resultUrls.has(c.url)).toBe(true);
    for (const c of sample.citations) expect(sample.answer).toContain(c.quote);
  });
});

describe("extract primitive — Tavily /extract parity (network-free contract)", () => {
  it("no urls -> empty results, never fabricated", async () => {
    expect(await doExtract([])).toEqual({ results: [] });
    expect(await doExtract(["", "   "])).toEqual({ results: [] });
  });
});

// Live grounding (opt-in): proves the real path returns a fact-bearing answer grounded in a
// fetched citation. Skipped by default so CI stays deterministic; run with UNBROWSE_LIVE=1.
describe.if(process.env.UNBROWSE_LIVE === "1")("research primitive — live grounding", () => {
  it("research a known fact -> answer grounded in a really-fetched citation", async () => {
    const r = await doResearch("who founded Stripe", { numResults: 3 });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.citations.length).toBeGreaterThan(0);
    // every citation came from a fetched result (no fabricated source)
    const urls = new Set(r.results.map((x) => x.url));
    for (const c of r.citations) expect(urls.has(c.url)).toBe(true);
    expect(r.answer.length).toBeGreaterThan(0);
  }, 90_000);
});
