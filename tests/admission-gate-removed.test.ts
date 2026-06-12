// Falsifier for removing the heuristic admission gate from
// shouldIndexDomBrowseFallback. Per CLAUDE.md platform-enables:
// "When the LLM picks the wrong tool: the gap is in tool description
//  honesty, not in adding a rule that says 'pick the right one.'"
//
// Pre-fix the function called validateExtractionQuality (rejects on
// confidence < 0.5, dupe-ratio > 0.5, concat patterns, etc.) AND
// assessIntentResult (semantic heuristic). Both are "synthesize a
// verdict in code" — exactly the pattern the rule forbids.
//
// Post-fix the function admits whenever the extractor produced data.
// Quality signals stay computed on the published skill as evidence
// fields the ranker + agent can read; they no longer GATE admission.
// Bad skills get demoted via reliability_score updates from
// unbrowse_reflect (the Darwinian-marketplace shape).
import { describe, expect, it } from "bun:test";
import { shouldIndexDomBrowseFallback } from "../src/api/browse-index.ts";

describe("shouldIndexDomBrowseFallback — admission gate removed (post-2026-05-18 platform clean-up)", () => {
  it("low confidence extracted data is ADMITTED (was rejected at 0.5 floor)", () => {
    // npm/crates.io anchor case: React hydration shell, conf 0.385.
    // Previously hard-rejected; agent never saw the data.
    const r = shouldIndexDomBrowseFallback({
      requestCount: 0,
      intent: "get package info",
      extractedData: [
        { name: "openai", version: "5.20.3", description: "OpenAI SDK" },
        { name: "openai-edge", version: "1.0.0", description: "Edge SDK" },
      ],
      extractedConfidence: 0.385,
      hasStructuredForm: false,
    });
    expect(r.allow).toBe(true);
  });

  it("highly-duplicate rows are ADMITTED (was rejected at 50% dupe ratio)", () => {
    // dockerhub tags anchor case: template-rendered tag cards.
    const dupeRow = { tag: "nginx:latest", digest: "sha256:abc" };
    const r = shouldIndexDomBrowseFallback({
      requestCount: 1,
      intent: "get dockerhub image tags",
      extractedData: [dupeRow, dupeRow, dupeRow, dupeRow, dupeRow],
      extractedConfidence: 0.56,
      hasStructuredForm: false,
    });
    expect(r.allow).toBe(true);
  });

  it("concat-detected values are ADMITTED (was rejected at 30% concat)", () => {
    const r = shouldIndexDomBrowseFallback({
      requestCount: 0,
      intent: "get stock data",
      extractedData: [
        { ticker: "AAPLApple Inc", price: "180.50" },
        { ticker: "MSFTMicrosoft", price: "420.75" },
      ],
      extractedConfidence: 0.7,
      hasStructuredForm: false,
    });
    expect(r.allow).toBe(true);
  });

  it("primitive-rows extraction is ADMITTED (was rejected on structured intent)", () => {
    const r = shouldIndexDomBrowseFallback({
      requestCount: 0,
      intent: "get top hacker news stories",
      extractedData: ["Story 1", "Story 2", "Story 3"],
      extractedConfidence: 0.7,
      hasStructuredForm: false,
    });
    expect(r.allow).toBe(true);
  });

  it("TRULY empty data is still rejected (the one legitimate reject)", () => {
    const r = shouldIndexDomBrowseFallback({
      requestCount: 0,
      intent: "get top hacker news stories",
      extractedData: null,
      extractedConfidence: 0,
      hasStructuredForm: false,
    });
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("no_dom_data");
  });

  it("empty data WITH a structured search form on a search intent still allowed (preserved)", () => {
    // The pre-fix code had a carve-out for "form + network evidence +
    // search intent" → admit even with no extracted data. Keep that;
    // it's not a heuristic verdict, it's recognizing that a search form
    // is itself a valid agent surface.
    const r = shouldIndexDomBrowseFallback({
      requestCount: 5,
      intent: "search for users",
      extractedData: null,
      extractedConfidence: 0,
      hasStructuredForm: true,
    });
    expect(r.allow).toBe(true);
    expect(r.intentLooksSearch).toBe(true);
  });
});
