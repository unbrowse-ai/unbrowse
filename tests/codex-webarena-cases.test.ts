import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAuthEvalCases } from "../evals/codex-auth-runner-lib.js";

const ROOT = join(import.meta.dir, "..");

describe("codex webarena cases", () => {
  it("stay multistep, scripted, and judge retrieval plus selection", () => {
    const raw = JSON.parse(
      readFileSync(join(ROOT, "evals", "codex-cases.webarena.json"), "utf-8"),
    );
    const cases = parseAuthEvalCases(raw);

    expect(cases.length).toBeGreaterThanOrEqual(4);

    const ids = new Set<string>();
    for (const testCase of cases) {
      expect(ids.has(testCase.id)).toBe(false);
      ids.add(testCase.id);
      expect(testCase.auth_bootstrap.strategy).toBe("scripted_login");
      expect(testCase.workflow?.steps.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(testCase.workflow?.verify?.length ?? 0).toBeGreaterThanOrEqual(1);

      for (const step of [...(testCase.workflow?.steps ?? []), ...(testCase.workflow?.verify ?? [])]) {
        expect(step.expected_fields.length).toBeGreaterThan(0);
        expect(step.validate?.retrieval?.any_of.length ?? 0).toBeGreaterThan(0);
        expect(step.validate?.selection?.any_of.length ?? 0).toBeGreaterThan(0);
      }
    }

    expect(ids.has("webarena-shopping-saucedemo")).toBe(true);
    expect(ids.has("webarena-admin-orangehrm")).toBe(true);
    expect(ids.has("webarena-secure-area")).toBe(true);
    expect(ids.has("webarena-practice-login-success")).toBe(true);
  });
});
