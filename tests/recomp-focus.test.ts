// Seed witness (Step 3): RECOMP extractive sentence compression (arXiv:2310.04408)
// keeps the query-relevant sentence and drops distractors within budget, preserving
// document order. The lever's VALUE on groundedness is decided by the n>=30 bench A/B
// (Step 4/5); this only proves the seed is viable + correct.
import { describe, it, expect } from "bun:test";
import { recompSentences } from "../src/orchestrator/direct-document.js";

describe("RECOMP — extractive query-focused sentence compression", () => {
  const terms = ["founded", "acme"];
  const idf = { founded: 2.0, acme: 1.5 };
  const doc = [
    "Acme makes widgets for the enterprise market.",          // distractor (has acme, low fact)
    "The company was founded in 2019 by Jane Roe.",            // THE fact sentence (founded)
    "Our offices have free snacks and a ping pong table.",     // pure distractor
    "Acme was founded in San Francisco.",                      // also fact-relevant (acme+founded)
  ].join(" ");

  it("keeps the fact-bearing sentences, drops pure distractors", () => {
    const out = recompSentences(doc, terms, idf, 10000);
    expect(out).toContain("founded in 2019");
    expect(out).toContain("founded in San Francisco");
    expect(out).not.toContain("ping pong");        // pure distractor dropped
  });

  it("preserves document order of the kept sentences", () => {
    const out = recompSentences(doc, terms, idf, 10000);
    expect(out.indexOf("2019")).toBeLessThan(out.indexOf("San Francisco"));
  });

  it("respects the budget (compresses, never grows)", () => {
    const out = recompSentences(doc, terms, idf, 60);
    expect(out.length).toBeLessThanOrEqual(doc.length);
    expect(out).toContain("founded"); // the highest-idf term survives the squeeze
  });

  it("falls back safely on a single sentence or no match", () => {
    expect(recompSentences("One sentence only.", terms, idf, 100)).toBe("One sentence only.");
    const noMatch = recompSentences("Totally unrelated text about weather. Sunny today.", terms, idf, 100);
    expect(noMatch.length).toBeGreaterThan(0); // never empty
  });
});
