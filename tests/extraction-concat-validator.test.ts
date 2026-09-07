// Falsifier for the validateExtractionQuality "concatenated values" reject.
// MCP gate run 20260518T115632Z showed probe 002 (npm package page) being
// rejected at extraction confidence 0.9 with reason
// "33% concatenated values detected" — because the digit-suffix regex
// `[a-zA-Z]\d{3,}` matches cache-busted hash filenames in the rendered
// HTML (e.g. `styles.bdb4cdf27288716a27f6.css` contains `b4cdf27288`),
// OpenLibrary work IDs like `OL45804W`, GitHub issue refs `issue1234`,
// version strings `v1234`, and build hashes — all valid identifiers
// being treated as concatenated finance values.
//
// The comment in src/execution/index.ts:381 specifies the intended catch:
// "AAPLApple" or "Inc978,583". The thousand-separator commas in the
// numeric example are load-bearing — they distinguish a formatted
// financial value jammed onto a company name from a build/version/issue
// number that legitimately shares the letter+digits shape.
//
// Fix: require digit-run to either carry comma-separators (the original
// "978,583" shape) OR be ≥6 digits without commas (clearly a count not a
// version/build number). Anything shorter or without commas is left
// alone; the ticker pattern stays as the primary detector for
// stock-name concatenations.
import { describe, expect, it } from "bun:test";
import { validateExtractionQuality } from "../src/execution/index.ts";

describe("validateExtractionQuality — concatenated-value false positives (gate run 20260518T115632Z)", () => {
// Each row gets a distinct id so the dedupe detector (>50% duplicate
// rows → reject) doesn't short-circuit before the concat detector runs.
function rowsWith(values: string[]): unknown[] {
    return values.map((v, i) => ({ id: i, name: v }));
  }

  it("flags real ticker-name concatenations (must stay)", () => {
    const result = validateExtractionQuality(
      rowsWith(["AAPLApple", "AAPLApple", "AAPLApple", "AAPLApple"]),
      0.85,
    );
    expect(result.valid).toBe(false);
    expect(result.quality_note ?? "").toContain("concatenated");
  });

  it("flags comma-formatted finance concatenation (the cited 'Inc978,583' pattern)", () => {
    const result = validateExtractionQuality(
      rowsWith(["AcmeInc978,583", "AcmeInc978,583", "AcmeInc978,583", "AcmeInc978,583"]),
      0.85,
    );
    expect(result.valid).toBe(false);
    expect(result.quality_note ?? "").toContain("concatenated");
  });

  it("does NOT flag cache-busted hash filenames (npm/webpack/Vite asset URLs)", () => {
    // Real npm page contains: styles.bdb4cdf27288716a27f6.css
    // The letter+digits shape is benign here — it's a hash, not a finance value.
    const result = validateExtractionQuality(
      rowsWith([
        "styles.bdb4cdf27288716a27f6.css",
        "main.4ad1b7c9.js",
        "vendor.f9c83d2a.js",
        "runtime.bdb4cdf27288716a27f6.css",
      ]),
      0.9,
    );
    expect(result.valid).toBe(true);
  });

  it("does NOT flag OpenLibrary work IDs (OL45804W, OL27448W)", () => {
    const result = validateExtractionQuality(
      rowsWith(["OL45804W", "OL27448W", "OL12345W", "OL99999W"]),
      0.85,
    );
    expect(result.valid).toBe(true);
  });

  it("does NOT flag GitHub issue refs and version numbers", () => {
    const result = validateExtractionQuality(
      rowsWith(["issue1234", "build5678", "v1234.5.6", "PR9876"]),
      0.85,
    );
    expect(result.valid).toBe(true);
  });

  it("does NOT flag npm package version strings", () => {
    const result = validateExtractionQuality(
      rowsWith(["openai@5.20.3", "react@18.3.1", "lodash@4.17.21", "anthropic@0.8.0"]),
      0.9,
    );
    expect(result.valid).toBe(true);
  });

  it("does NOT flag 6+ digit raw counts WITHOUT a letter prefix (those aren't concatenations)", () => {
    // "Downloads" + "1,234,567" gets handled by the comma-pattern above.
    // But "1234567" alone is just a number — no letter prefix means
    // isConcatenatedValue returns false trivially.
    const result = validateExtractionQuality(
      rowsWith(["1234567", "2345678", "3456789", "4567890"]),
      0.9,
    );
    expect(result.valid).toBe(true);
  });
});
