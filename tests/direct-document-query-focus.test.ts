import { describe, it, expect } from "bun:test";
import { focusMarkdownToIntent } from "../src/orchestrator/direct-document.js";

// The single `unbrowse "<query>" --url` call carries the intent; when a large page
// exceeds the markdown budget, the result must be FOCUSED to the query-relevant
// passage (chunk + rank by the query's rare/IDF-weighted terms, kept in document
// order) — not head-truncated, which drops a deep answer (e.g. a W3C spec's
// `atomicCompareExchangeWeak` signature). Validated win: exa-rag groundedness
// 0.333 → 0.400 (+0.0667, reliable n=30).
describe("focusMarkdownToIntent — query-focus surfaces the deep answer", () => {
  const filler = Array.from({ length: 400 }, (_, i) => `Section ${i}: generic prose about unrelated topics and boilerplate navigation chrome.`).join("\n\n");
  const deepAnswer = "atomicCompareExchangeWeak(atomic_ptr, cmp, v) -> vec2<T>";
  const page = `${filler}\n\n${deepAnswer}\n\n${filler}`; // answer buried in the middle

  it("includes the deep query-relevant passage when head-truncation would cut it", () => {
    const budget = 4000; // far smaller than the page; head-truncate would keep only Section 0..
    const headTrunc = page.slice(0, budget);
    expect(headTrunc.includes(deepAnswer)).toBe(false); // baseline loses it
    const focused = focusMarkdownToIntent(page, "WGSL atomicCompareExchangeWeak return type", budget);
    expect(focused.includes("atomicCompareExchangeWeak")).toBe(true); // focus keeps it
    expect(focused.length).toBeLessThanOrEqual(budget);
  });

  it("respects the off-switch (UNBROWSE_QUERY_FOCUS=0 → head-truncate)", () => {
    const prev = process.env.UNBROWSE_QUERY_FOCUS;
    process.env.UNBROWSE_QUERY_FOCUS = "0";
    try {
      const out = focusMarkdownToIntent(page, "atomicCompareExchangeWeak", 4000);
      expect(out).toBe(page.slice(0, 4000)); // baseline head-truncation
    } finally {
      if (prev === undefined) delete process.env.UNBROWSE_QUERY_FOCUS; else process.env.UNBROWSE_QUERY_FOCUS = prev;
    }
  });

  it("no intent or fits-in-budget → unchanged", () => {
    expect(focusMarkdownToIntent(page, undefined, 4000)).toBe(page.slice(0, 4000)); // no query → head-truncate
    const small = "short page";
    expect(focusMarkdownToIntent(small, "anything", 4000)).toBe(small); // fits → unchanged
  });
});
