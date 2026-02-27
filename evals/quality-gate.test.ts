#!/usr/bin/env bun
/**
 * Quality gate eval — unit tests for extraction quality validation.
 *
 * Tests the three quality checks that prevent garbage from reaching the marketplace:
 *   1. Concatenation detection (AAPLApple, Inc978)
 *   2. Deduplication (>50% duplicate rows)
 *   3. Diversity (all items share same link/title = nav chrome)
 *
 * Also tests SPA data extraction on synthetic HTML.
 *
 * Usage:
 *   bun test evals/quality-gate.test.ts
 */

import { describe, test, expect } from "bun:test";
import { extractFromDOM, extractSPAData } from "../src/extraction/index.js";

// --- Helpers: import quality validation logic inline ---
// (These mirror the functions in execution/index.ts for isolated testing)

function isConcatenatedValue(s: string): boolean {
  if (/[A-Z]{2,}[A-Z][a-z]/.test(s)) return true;
  if (/[a-zA-Z]\d{3,}/.test(s)) return true;
  return false;
}

interface QualityResult {
  valid: boolean;
  quality_note?: string;
}

function validateExtractionQuality(data: unknown, confidence: number): QualityResult {
  if (confidence < 0.5) {
    return { valid: false, quality_note: `confidence too low (${confidence.toFixed(2)} < 0.5)` };
  }

  if (!Array.isArray(data)) return { valid: true };
  if (data.length === 0) return { valid: true };

  const serialized = data.map((item) => JSON.stringify(item));
  const unique = new Set(serialized);
  const dupeRatio = 1 - unique.size / serialized.length;
  if (dupeRatio > 0.5) {
    return { valid: false, quality_note: `${Math.round(dupeRatio * 100)}% duplicate rows` };
  }

  let totalStrings = 0;
  let concatStrings = 0;
  for (const item of data) {
    if (item && typeof item === "object") {
      for (const val of Object.values(item as Record<string, unknown>)) {
        if (typeof val === "string" && val.length > 3) {
          totalStrings++;
          if (isConcatenatedValue(val)) concatStrings++;
        }
      }
    }
  }
  if (totalStrings > 0 && concatStrings / totalStrings > 0.3) {
    return { valid: false, quality_note: `${Math.round((concatStrings / totalStrings) * 100)}% concatenated values detected` };
  }

  if (data.length >= 3) {
    for (const field of ["link", "href", "url", "title"]) {
      const vals = data
        .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>)[field] : undefined))
        .filter((v) => v != null);
      if (vals.length >= 3) {
        const uniqueVals = new Set(vals.map(String));
        if (uniqueVals.size === 1) {
          return { valid: false, quality_note: `all items share the same "${field}" — likely navigation chrome` };
        }
      }
    }
  }

  return { valid: true };
}

// ==========================================================================
// Tests: Concatenation detection
// ==========================================================================

describe("isConcatenatedValue", () => {
  test("detects ticker+name concatenation", () => {
    expect(isConcatenatedValue("AAPLApple")).toBe(true);
    expect(isConcatenatedValue("NVDANvidia")).toBe(true);
    expect(isConcatenatedValue("TSLATesla")).toBe(true);
    expect(isConcatenatedValue("GOOGAlphabet")).toBe(true);
  });

  test("detects word+number concatenation", () => {
    expect(isConcatenatedValue("Inc978,583")).toBe(true);
    expect(isConcatenatedValue("Corp1200")).toBe(true);
    expect(isConcatenatedValue("Stock9876")).toBe(true);
  });

  test("passes clean values", () => {
    expect(isConcatenatedValue("Apple Inc")).toBe(false);
    expect(isConcatenatedValue("AAPL")).toBe(false);
    expect(isConcatenatedValue("978,583")).toBe(false);
    expect(isConcatenatedValue("Nvidia Corporation")).toBe(false);
    expect(isConcatenatedValue("Q4 2024")).toBe(false);
  });
});

// ==========================================================================
// Tests: Quality gate
// ==========================================================================

describe("validateExtractionQuality", () => {
  test("rejects low confidence", () => {
    const result = validateExtractionQuality([{ title: "test" }], 0.3);
    expect(result.valid).toBe(false);
    expect(result.quality_note).toContain("confidence too low");
  });

  test("rejects >50% duplicate rows", () => {
    const data = [
      { title: "Apple Inc", price: "$178.50" },
      { title: "Apple Inc", price: "$178.50" },
      { title: "Apple Inc", price: "$178.50" },
      { title: "Apple Inc", price: "$178.50" },
      { title: "Nvidia", price: "$890.30" },
    ];
    // 4/5 dupes = 80% dupe ratio -> only 2 unique out of 5 = 60% dupe ratio
    const result = validateExtractionQuality(data, 0.6);
    expect(result.valid).toBe(false);
    expect(result.quality_note).toContain("duplicate");
  });

  test("rejects >30% concatenated values", () => {
    const data = [
      { title: "AAPLApple", info: "Inc978,583" },
      { title: "NVDANvidia", info: "Corp1,200" },
      { title: "TSLATesla", info: "Inc800" },
    ];
    const result = validateExtractionQuality(data, 0.6);
    expect(result.valid).toBe(false);
    expect(result.quality_note).toContain("concatenated");
  });

  test("rejects nav chrome (all same link)", () => {
    const data = [
      { title: "Home", link: "/nav" },
      { title: "About", link: "/nav" },
      { title: "Contact", link: "/nav" },
    ];
    const result = validateExtractionQuality(data, 0.7);
    expect(result.valid).toBe(false);
    expect(result.quality_note).toContain("navigation chrome");
  });

  test("rejects nav chrome (all same title)", () => {
    const data = [
      { title: "StockTwits", link: "/a" },
      { title: "StockTwits", link: "/b" },
      { title: "StockTwits", link: "/c" },
    ];
    const result = validateExtractionQuality(data, 0.7);
    expect(result.valid).toBe(false);
    expect(result.quality_note).toContain("same \"title\"");
  });

  test("passes clean structured data", () => {
    const data = [
      { title: "Apple Inc", ticker: "AAPL", price: "$178.50" },
      { title: "Nvidia Corporation", ticker: "NVDA", price: "$890.30" },
      { title: "Tesla Inc", ticker: "TSLA", price: "$245.00" },
    ];
    const result = validateExtractionQuality(data, 0.8);
    expect(result.valid).toBe(true);
    expect(result.quality_note).toBeUndefined();
  });

  test("passes non-array data", () => {
    const result = validateExtractionQuality({ key: "value" }, 0.8);
    expect(result.valid).toBe(true);
  });

  test("passes the StockTwits garbage example from bug report", () => {
    // This is the exact garbage from the bug report — should be rejected
    const data = [
      { title: "AAPLApple Inc", info: "AAPLApple Inc978,583" },
      { title: "AAPLApple Inc", info: "AAPLApple Inc978,583" },
      { title: "NVDANvidia", info: "NVDANvidia1,200,000" },
    ];
    const result = validateExtractionQuality(data, 0.6);
    expect(result.valid).toBe(false);
  });
});

// ==========================================================================
// Tests: SPA data extraction
// ==========================================================================

describe("extractSPAData", () => {
  test("extracts Next.js __NEXT_DATA__", () => {
    const html = `
      <html><head></head><body>
        <div id="__next">Loading...</div>
        <script id="__NEXT_DATA__" type="application/json">
          {"props":{"pageProps":{"discussions":[{"id":1,"text":"AAPL to the moon"}],"news":[{"id":1,"title":"Market update"}]}}}
        </script>
      </body></html>
    `;
    const results = extractSPAData(html);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("spa-nextjs");
    expect((results[0].data as any).discussions).toHaveLength(1);
    expect((results[0].data as any).news).toHaveLength(1);
  });

  test("extracts window.__INITIAL_STATE__", () => {
    const html = `
      <html><head></head><body>
        <script>window.__INITIAL_STATE__={"user":{"name":"test"},"posts":[1,2,3]};</script>
      </body></html>
    `;
    const results = extractSPAData(html);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("spa-initial-state");
    expect((results[0].data as any).user.name).toBe("test");
  });

  test("extracts window.__PRELOADED_STATE__", () => {
    const html = `
      <html><head></head><body>
        <script>window.__PRELOADED_STATE__={"items":[{"id":1},{"id":2}]};</script>
      </body></html>
    `;
    const results = extractSPAData(html);
    expect(results.length).toBe(1);
    expect(results[0].type).toBe("spa-preloaded-state");
  });

  test("returns empty for pages without SPA data", () => {
    const html = `<html><head></head><body><h1>Hello</h1></body></html>`;
    const results = extractSPAData(html);
    expect(results).toHaveLength(0);
  });

  test("handles malformed JSON gracefully", () => {
    const html = `
      <html><body>
        <script id="__NEXT_DATA__" type="application/json">{broken json</script>
      </body></html>
    `;
    const results = extractSPAData(html);
    expect(results).toHaveLength(0);
  });
});

// ==========================================================================
// Tests: extractFromDOM with SPA data
// ==========================================================================

describe("extractFromDOM with SPA data", () => {
  test("prefers SPA data over DOM scraping", () => {
    const html = `
      <html><head></head><body>
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <div id="__next"><div class="card"><h2>StockTwits</h2></div></div>
        <script id="__NEXT_DATA__" type="application/json">
          {"props":{"pageProps":{"trending":[{"symbol":"AAPL","name":"Apple","volume":978583},{"symbol":"NVDA","name":"Nvidia","volume":1200000}]}}}
        </script>
      </body></html>
    `;
    const result = extractFromDOM(html, "trending stocks");
    expect(result.extraction_method).toBe("spa-nextjs");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect((result.data as any).trending).toHaveLength(2);
    // Data should be clean — no concatenation
    const trending = (result.data as any).trending;
    expect(trending[0].symbol).toBe("AAPL");
    expect(trending[0].name).toBe("Apple");
  });
});
