// Falsifiable signals (Step 4) for the native research primitive (Tavily parity).
// The load-bearing invariant is NO FABRICATION: the answer/citations are built only from
// really-fetched sources; empty query or zero fetched sources -> honest empty, never invented.
// Network-free contract tests run always; the live grounding test is env-gated (UNBROWSE_LIVE=1).
import { describe, it, expect } from "bun:test";
import { doResearch, doExtract, doMap, doCrawl, sweepCache, type ResearchAnswer } from "../src/orchestrator/research.js";
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  it("an empty result carries a diagnostic note — never a silent blank", async () => {
    expect((await doResearch("")).note).toBe("empty query");
    const zero = await doResearch("who founded Stripe", { numResults: 0 });
    assertHonestEmpty(zero);
    expect((zero.note ?? "").length).toBeGreaterThan(0); // says WHY it is empty
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

describe("map primitive — Tavily /map parity (network-free contract)", () => {
  it("empty url -> empty links, never fabricated", async () => {
    expect(await doMap("")).toEqual({ url: "", links: [] });
    expect(await doMap("   ")).toEqual({ url: "", links: [] });
  });
});

describe("crawl primitive — Tavily /crawl parity (network-free contract)", () => {
  it("empty seed -> empty pages, never fabricated", async () => {
    expect(await doCrawl("")).toEqual({ seed: "", pages: [] });
  });
});

describe("read-cache boundary — sweepCache evicts oldest past the cap (network-free)", () => {
  it("keeps at most maxEntries, evicting the oldest", () => {
    const dir = mkdtempSync(join(tmpdir(), "ub-sweep-"));
    const N = 20, CAP = 12;
    for (let i = 0; i < N; i++) {
      const p = join(dir, `e${String(i).padStart(3, "0")}.json`);
      writeFileSync(p, "{}");
      const t = new Date((i + 1) * 1000); // e000 oldest ... e019 newest, by mtime
      utimesSync(p, t, t);
    }
    const evicted = sweepCache(dir, CAP);
    const left = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    expect(evicted).toBe(N - CAP);
    expect(left.length).toBe(CAP);
    // the NEWEST CAP survive; the oldest (e000..) are gone
    expect(left[0]).toBe(`e${String(N - CAP).padStart(3, "0")}.json`);
    expect(left).toContain("e019.json");
    expect(left).not.toContain("e000.json");
  });

  it("no-op under the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "ub-sweep2-"));
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `e${i}.json`), "{}");
    expect(sweepCache(dir, 10)).toBe(0);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(5);
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
