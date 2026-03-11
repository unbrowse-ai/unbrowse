import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHarnessCases } from "../evals/codex-harness-lib.js";

const ROOT = join(import.meta.dir, "..");

describe("codex agent target cases", () => {
  it("stay public, unique, and broader than the stable suite", () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, "evals", "codex-cases.agent-targets.json"), "utf-8"),
    );
    const cases = normalizeHarnessCases(raw);

    expect(cases.length).toBeGreaterThanOrEqual(20);

    const ids = new Set<string>();
    for (const testCase of cases) {
      expect(testCase.auth).toBeUndefined();
      expect(testCase.intent.length).toBeGreaterThan(0);
      expect(testCase.expected_fields.length).toBeGreaterThan(0);
      expect(testCase.url.startsWith("https://")).toBe(true);
      expect(ids.has(testCase.id)).toBe(false);
      ids.add(testCase.id);
    }

    expect(ids.has("arxiv-search-papers")).toBe(true);
    expect(ids.has("huggingface-search-models")).toBe(true);
    expect(ids.has("allrecipes-search-recipes")).toBe(true);
    expect(ids.has("coursera-search-courses")).toBe(true);
    expect(ids.has("cambridge-get-definition")).toBe(true);
    expect(ids.has("hacker-news-search")).toBe(true);
    expect(ids.has("jmail-search")).toBe(true);
    expect(ids.has("stack-overflow-tag-questions")).toBe(true);
    expect(ids.has("mdn-search-docs")).toBe(true);
    expect(ids.has("devto-tag-posts")).toBe(true);
    expect(ids.has("crates-search-packages")).toBe(true);
    expect(ids.has("rubygems-package-info")).toBe(true);
    expect(ids.has("pubdev-package-info")).toBe(true);
    expect(ids.has("lobsters-frontpage")).toBe(true);
  });
});
