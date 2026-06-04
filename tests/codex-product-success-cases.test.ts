import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHarnessCases } from "../evals/codex-harness-lib.js";

const ROOT = join(import.meta.dir, "..");

describe("codex product-success cases", () => {
  it("stay public, task-shaped, and agent-realistic", () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, "evals", "codex-cases.product-success.json"), "utf-8"),
    );
    const cases = normalizeHarnessCases(raw);

    expect(cases.length).toBeGreaterThanOrEqual(8);

    const ids = new Set<string>();
    let seededParams = 0;
    for (const testCase of cases) {
      expect(testCase.auth).toBeUndefined();
      expect(testCase.intent.length).toBeGreaterThan(0);
      expect(testCase.expected_fields.length).toBeGreaterThan(0);
      expect(testCase.url.startsWith("https://")).toBe(true);
      expect(ids.has(testCase.id)).toBe(false);
      ids.add(testCase.id);

      const parsed = new URL(testCase.url);
      const rootOnly = parsed.pathname === "/" && parsed.search.length === 0;
      expect(rootOnly && !testCase.params).toBe(false);
      if (testCase.params) seededParams += 1;
    }

    expect(ids.has("github-search-repositories")).toBe(true);
    expect(ids.has("hn-search-param-seeded")).toBe(true);
    expect(ids.has("mdn-search-docs")).toBe(true);
    expect(ids.has("stack-overflow-tag-questions")).toBe(true);
    expect(ids.has("devto-tag-posts")).toBe(true);
    expect(ids.has("rubygems-package-info")).toBe(true);
    expect(ids.has("pubdev-package-info")).toBe(true);
    expect(ids.has("jmail-search")).toBe(true);
    expect(seededParams).toBeGreaterThanOrEqual(1);
  });
});
