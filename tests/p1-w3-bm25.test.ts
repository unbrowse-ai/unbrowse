/**
 * tests/p1-w3-bm25.test.ts — Sermon-on-the-Mount signals over P1 W3 cluster #1.
 *
 * Falsifiable invariants over the bm25 extraction shipped in this loop:
 *   1. New module src/lib/ranking-core/signals/bm25.ts exists; exports `bm25Score`,
 *      `BM25_K1`, `BM25_B`, `BM25_DELTA_WEIGHT`.
 *   2. Constants carry the exact paper §3.3 values (K1=1.2, B=0.75) and
 *      the previously-magic multiplier (DELTA_WEIGHT=20).
 *   3. Numeric behavior on a known fixture matches the byte-identical
 *      pre-extraction value computed from the original code.
 *   4. Anti-goal: src/execution/index.ts no longer contains the function
 *      definition or the `const BM25_K1 = 1.2;` line — extraction is
 *      irreversible (re-introducing them is what breaks this signal).
 *   5. The import in src/execution/index.ts uses the new path.
 *
 * Run: bun test tests/p1-w3-bm25.test.ts
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BM25_B,
  BM25_DELTA_WEIGHT,
  BM25_K1,
  bm25Score,
} from "../src/lib/ranking-core/signals/bm25.js";

const REPO_ROOT = join(import.meta.dir, "..");

describe("P1 W3 cluster #1 — bm25 module surface", () => {
  it("exports a callable bm25Score function", () => {
    expect(typeof bm25Score).toBe("function");
  });

  it("constants carry paper §3.3 values", () => {
    expect(BM25_K1).toBe(1.2);
    expect(BM25_B).toBe(0.75);
  });

  it("BM25_DELTA_WEIGHT preserves the previously-magic `* 20` multiplier", () => {
    expect(BM25_DELTA_WEIGHT).toBe(20);
  });
});

describe("P1 W3 cluster #1 — bm25 numeric behavior parity", () => {
  it("known fixture produces the pre-extraction byte-identical value", () => {
    const docs = [
      ["search", "people", "linkedin"],
      ["company", "detail"],
    ];
    const docFreqs = new Map<string, number>([
      ["search", 1],
      ["people", 1],
      ["linkedin", 1],
      ["company", 1],
      ["detail", 1],
    ]);
    const score = bm25Score(["people"], docs[0], 2.5, 2, docFreqs);
    // Verified pre-extraction value via inline run of the original
    // src/execution/index.ts:bm25Score; if the algorithm changes, this
    // baseline must be updated in the SAME commit with a CHANGELOG entry.
    expect(score).toBeCloseTo(0.640724, 5);
  });

  it("zero-overlap query returns zero score", () => {
    const score = bm25Score(
      ["nonexistent"],
      ["a", "b"],
      2,
      1,
      new Map<string, number>([
        ["a", 1],
        ["b", 1],
      ]),
    );
    expect(score).toBe(0);
  });

  it("empty doc returns zero score", () => {
    const score = bm25Score(
      ["term"],
      [],
      0,
      1,
      new Map<string, number>([["term", 1]]),
    );
    expect(score).toBe(0);
  });
});

describe("P1 W3 cluster #1 — extraction anti-goal anchor", () => {
  it("src/execution/index.ts no longer defines `function bm25Score`", () => {
    const text = readFileSync(
      join(REPO_ROOT, "src/execution/index.ts"),
      "utf8",
    );
    expect(text).not.toMatch(/^function bm25Score\s*\(/m);
  });

  it("src/execution/index.ts no longer declares `const BM25_K1` or `const BM25_B`", () => {
    const text = readFileSync(
      join(REPO_ROOT, "src/execution/index.ts"),
      "utf8",
    );
    expect(text).not.toMatch(/^const BM25_K1\s*=/m);
    expect(text).not.toMatch(/^const BM25_B\s*=/m);
  });

  it("src/execution/index.ts imports bm25 symbols from the new path", () => {
    const text = readFileSync(
      join(REPO_ROOT, "src/execution/index.ts"),
      "utf8",
    );
    expect(text).toMatch(
      /import\s*\{\s*bm25Score[^}]*\}\s*from\s*"\.\.\/lib\/ranking-core\/signals\/bm25\.js"/,
    );
  });

  it("the call site uses BM25_DELTA_WEIGHT (no remaining magic `* 20`)", () => {
    const text = readFileSync(
      join(REPO_ROOT, "src/execution/index.ts"),
      "utf8",
    );
    expect(text).toContain("bm25Score(queryTokens, docs[i], avgDl, docCount, docFreqs)) * BM25_DELTA_WEIGHT");
  });
});

// ---------------------------------------------------------------------------
// Step 5 ministry — edges + adversarial under real conditions.
// ---------------------------------------------------------------------------

describe("P1 W3 cluster #1 — bm25 ministry: edges", () => {
  it("empty query returns 0", () => {
    const out = bm25Score(
      [],
      ["a", "b"],
      2,
      1,
      new Map<string, number>([
        ["a", 1],
        ["b", 1],
      ]),
    );
    expect(out).toBe(0);
  });

  it("K1 saturation: 100× repeated term yields a bounded finite score", () => {
    const doc = Array(100).fill("term");
    const out = bm25Score(
      ["term"],
      doc,
      100,
      1,
      new Map<string, number>([["term", 1]]),
    );
    // Saturation via K1=1.2 prevents unbounded growth from raw frequency.
    // Empirical value at this fixture: ~0.6254 (within bounded range).
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(2); // upper bound for K1=1.2 single-doc IDF
  });

  it("B length-normalization: 1001-token doc still yields finite non-zero score", () => {
    const longDoc = Array(1000).fill("x").concat(["term"]);
    const out = bm25Score(
      ["term"],
      longDoc,
      100,
      1,
      new Map<string, number>([
        ["term", 1],
        ["x", 1],
      ]),
    );
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThan(0);
    // Long-doc penalty bounds it well under the saturation case above.
    expect(out).toBeLessThan(0.5);
  });
});

describe("P1 W3 cluster #1 — bm25 ministry: adversarial", () => {
  it("NaN docCount + NaN docFreq propagates NaN without throwing (caller responsibility)", () => {
    let threw = false;
    let result: number = 0;
    try {
      result = bm25Score(
        ["term"],
        ["term"],
        1,
        NaN,
        new Map<string, number>([["term", NaN]]),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Documented contract: bm25Score does NOT clamp/validate NaN — it
    // propagates so the caller (rankEndpoints setup pipeline) detects
    // corrupt upstream signals at the seam, not silently masks them.
    expect(Number.isNaN(result)).toBe(true);
  });

  it("doc with no matching terms returns 0 (no IDF dilution)", () => {
    const out = bm25Score(
      ["nonexistent"],
      ["a", "b", "c"],
      3,
      1,
      new Map<string, number>([
        ["a", 1],
        ["b", 1],
        ["c", 1],
      ]),
    );
    expect(out).toBe(0);
  });
});
