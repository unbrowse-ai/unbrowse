import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHarnessCases } from "../evals/codex-harness-lib.js";

const ROOT = join(import.meta.dir, "..");

describe("codex public cases", () => {
  it("stay public, unique, and runnable", () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, "evals", "codex-cases.public.json"), "utf-8"),
    );
    const cases = normalizeHarnessCases(raw);

    expect(cases.length).toBeGreaterThanOrEqual(5);

    const ids = new Set<string>();
    for (const testCase of cases) {
      expect(testCase.auth).toBeUndefined();
      expect(testCase.intent.length).toBeGreaterThan(0);
      expect(testCase.expected_fields.length).toBeGreaterThan(0);
      expect(testCase.url.startsWith("https://")).toBe(true);
      expect(ids.has(testCase.id)).toBe(false);
      ids.add(testCase.id);
    }
  });
});
