/**
 * tests/p1-wave1.test.ts — Sermon-on-the-Mount signals over Step-1-of-P1.
 *
 * Falsifiable invariants over the 4 seeds shipped in Step 3:
 *
 *   1. src/client/rank-server-first.ts re-exports the IDENTICAL function reference
 *      (not a copy) as src/execution/index.ts.
 *   2. .planning/phases/01-unified-ranking/01-01-PLAN.md exists with
 *      complete GSD frontmatter (phase, plan, title, wave, depends_on,
 *      files_modified, autonomous, requirements).
 *   3. .planning/phases/01-unified-ranking/01-RESEARCH.md exists.
 *   4. PAPER_PLAN.md no longer carries the orphan ±15 % / 2.4× drift.
 *   5. CHANGELOG.md Unreleased > Features mentions the ranking seed.
 *
 * Wave-1 anti-goal: src/execution/index.ts:rankEndpoints stays unchanged.
 * The identity check (#1) plus the lack of any new code in src/ranking/
 * (the file is a 25-line re-export) is the structural assertion that
 * preserves this anti-goal.
 *
 * Run: bun test tests/p1-wave1.test.ts
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { rankEndpoints as rankFromRanking } from "../src/client/rank-server-first.js";
import { rankEndpoints as rankFromExecution } from "../src/execution/index.js";

const REPO_ROOT = join(import.meta.dir, "..");

describe("P1 Wave-1: src/ranking/ re-export identity", () => {
  it("rankEndpoints is the SAME function reference in both modules", () => {
    expect(rankFromRanking).toBe(rankFromExecution);
  });

  it("calling via the new path returns [] for empty input (behavior preserved)", () => {
    expect(rankFromRanking([])).toEqual([]);
  });
});

describe("P1 Wave-1: GSD phase artifacts on disk", () => {
  const phaseDir = join(REPO_ROOT, ".planning/phases/01-unified-ranking");

  it("01-RESEARCH.md exists", () => {
    expect(existsSync(join(phaseDir, "01-RESEARCH.md"))).toBe(true);
  });

  it("01-01-PLAN.md exists", () => {
    expect(existsSync(join(phaseDir, "01-01-PLAN.md"))).toBe(true);
  });

  it("01-01-PLAN.md frontmatter declares all 8 required GSD fields", () => {
    const text = readFileSync(join(phaseDir, "01-01-PLAN.md"), "utf8");
    const match = text.match(/^---\n([\s\S]+?)\n---/);
    expect(match).not.toBeNull();
    const frontmatter = match![1];
    for (const field of [
      "phase:",
      "plan:",
      "title:",
      "wave:",
      "depends_on:",
      "files_modified:",
      "autonomous:",
      "requirements:",
    ]) {
      expect(frontmatter).toContain(field);
    }
  });

  it("01-01-PLAN.md frontmatter binds the plan to PAPER_PLAN-P1", () => {
    const text = readFileSync(join(phaseDir, "01-01-PLAN.md"), "utf8");
    expect(text).toContain("PAPER_PLAN-P1");
  });
});

describe("P1 Wave-1: PAPER_PLAN.md drift purged", () => {
  const plan = readFileSync(join(REPO_ROOT, "PAPER_PLAN.md"), "utf8");

  it("no ±15 % band reference remains", () => {
    expect(plan).not.toContain("±15 %");
    expect(plan).not.toContain("± 15");
  });

  it("no 2.4× threshold reference remains (replaced by 2.7× under ±25 %)", () => {
    expect(plan).not.toContain("2.4×");
  });

  it("Honesty contingency appears exactly once", () => {
    const matches = plan.match(/### Honesty contingency/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('"If P5 reveals" appears exactly once', () => {
    const matches = plan.match(/If P5 reveals/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("P1 Wave-1: CHANGELOG carries the seed entry", () => {
  const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");

  it("unreleased history mentions ranking seed", () => {
    expect(changelog).toContain("## [Unreleased]");
    expect(changelog).toContain("**ranking:**");
    expect(changelog).toContain("src/client/rank-server-first.ts");
  });
});

// ---------------------------------------------------------------------------
// Step 5 ministry — golden + edges + adversarial
// ---------------------------------------------------------------------------

describe("P1 Wave-1 ministry: golden — real fixture, identical output via both paths", () => {
  it("ranking via src/ranking/ produces the SAME ordered output as src/execution/", () => {
    const fixture = [
      {
        endpoint_id: "ep-detail",
        method: "GET",
        url_template: "https://www.example.com/api/companies/{id}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
      {
        endpoint_id: "ep-search",
        method: "GET",
        url_template: "https://www.example.com/api/search?q={query}",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.8,
        dom_extraction: { extraction_method: "repeated-elements", confidence: 0.9 },
      },
    ] as never[];

    const viaRanking = rankFromRanking(fixture, "search companies", "www.example.com");
    const viaExecution = rankFromExecution(fixture, "search companies", "www.example.com");

    expect(viaRanking).toEqual(viaExecution);
    expect(viaRanking.length).toBe(viaExecution.length);
    for (let i = 0; i < viaRanking.length; i++) {
      expect(viaRanking[i].endpoint.endpoint_id).toBe(viaExecution[i].endpoint.endpoint_id);
      expect(viaRanking[i].score).toBe(viaExecution[i].score);
    }
  });
});

describe("P1 Wave-1 ministry: edge — HEAD/OPTIONS endpoints filtered out (preamble preserved)", () => {
  it("HEAD method endpoints are dropped before scoring on both paths", () => {
    const fixture = [
      {
        endpoint_id: "ep-head",
        method: "HEAD",
        url_template: "https://www.example.com/api/ping",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
      {
        endpoint_id: "ep-options",
        method: "OPTIONS",
        url_template: "https://www.example.com/api/ping",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
      {
        endpoint_id: "ep-real",
        method: "GET",
        url_template: "https://www.example.com/api/data",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.9,
      },
    ] as never[];

    const viaRanking = rankFromRanking(fixture, "fetch data", "www.example.com");
    expect(viaRanking.find((r) => r.endpoint.endpoint_id === "ep-head")).toBeUndefined();
    expect(viaRanking.find((r) => r.endpoint.endpoint_id === "ep-options")).toBeUndefined();
    expect(viaRanking.find((r) => r.endpoint.endpoint_id === "ep-real")).toBeDefined();
  });
});

describe("P1 Wave-1 ministry: edge — empty intent does not crash", () => {
  it("rankEndpoints accepts undefined intent and returns a result list", () => {
    const fixture = [
      {
        endpoint_id: "ep-no-intent",
        method: "GET",
        url_template: "https://www.example.com/api/data",
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.5,
      },
    ] as never[];
    const out = rankFromRanking(fixture);
    expect(Array.isArray(out)).toBe(true);
  });
});

describe("P1 Wave-1 ministry: adversarial — anti-goal anchor (no migration yet)", () => {
  it("src/execution/index.ts still carries ≥ 30 score-delta lines (Wave-1 MUST NOT have migrated)", () => {
    const text = readFileSync(join(REPO_ROOT, "src/execution/index.ts"), "utf8");
    const matches = text.match(/score \+= /g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(30);
  });

  it("src/client/rank-server-first.ts contains NO inline scoring logic (it is a re-export only)", () => {
    const text = readFileSync(join(REPO_ROOT, "src/client/rank-server-first.ts"), "utf8");
    expect(text).not.toMatch(/score \+= /);
    expect(text).not.toMatch(/score -= /);
    expect(text).toContain('export { rankEndpoints }');
  });
});
