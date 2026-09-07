import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterAuthEvalCases, parseAuthEvalCases } from "../evals/codex-auth-runner-lib.js";

const ROOT = join(import.meta.dir, "..");

describe("codex auth cases", () => {
  it("ships a mixed auth corpus with popular cookie-reuse sites and scripted demos", () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, "evals", "codex-cases.auth-popular.json"), "utf-8"),
    );
    const cases = parseAuthEvalCases(raw);

    expect(cases.length).toBeGreaterThanOrEqual(12);

    const ids = new Set<string>();
    for (const testCase of cases) {
      expect(ids.has(testCase.id)).toBe(false);
      ids.add(testCase.id);
      expect(testCase.auth).toBeDefined();
      expect(testCase.expected_fields.length).toBeGreaterThan(0);
      expect(testCase.auth_bootstrap.strategy.length).toBeGreaterThan(0);
      expect(testCase.url.startsWith("https://")).toBe(true);
    }

    const popular = filterAuthEvalCases(cases, { suite: "popular-cookie-reuse" });
    const demos = filterAuthEvalCases(cases, { suite: "scripted-demo" });

    expect(popular.length).toBeGreaterThanOrEqual(8);
    expect(demos.length).toBeGreaterThanOrEqual(3);
    expect(ids.has("amazon-order-history")).toBe(true);
    expect(ids.has("x-bookmarks")).toBe(true);
    expect(ids.has("linkedin-people-search")).toBe(true);
    expect(ids.has("discord-dms")).toBe(true);
    expect(ids.has("saucedemo-products")).toBe(true);
    expect(ids.has("the-internet-secure-flash")).toBe(true);
  });
});
