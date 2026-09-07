import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCliPlan,
  derivePromptCases,
  renderCorpus,
  validateCliPlan,
  validatePromptCases,
  type AuthInventoryEnvelope,
} from "../scripts/bookmark-prompt-harness.js";

describe("bookmark prompt harness", () => {
  const fixture: AuthInventoryEnvelope = {
    ok: true,
    sources_scanned: ["dia:/tmp/Dia/User Data/Default"],
    locked_sources: [],
    inventory: {
      "github.com": {
        fresh_cookie: true,
        visit_count: 3554,
        bookmarked: false,
        likely_logged_in_score: 0.9,
      },
      "transitive-bs.notion.site": {
        visit_count: 0,
        bookmarked: true,
        likely_logged_in_score: 0.1,
      },
      "support.mozilla.org": {
        visit_count: 8,
        bookmarked: true,
        likely_logged_in_score: 0.1,
      },
      "example.com/path?token=SHOULD-NOT-LEAK": {
        visit_count: 20,
        bookmarked: true,
        likely_logged_in_score: 0.1,
      },
    },
  };

  it("derives origin-only Plan-Build-Test-Judge cases", () => {
    const cases = derivePromptCases(fixture.inventory!, 10);
    expect(validatePromptCases(cases)).toEqual([]);
    expect(cases.length).toBe(4);
    expect(cases.every((c) => c.command.join(" ") === "read resolve")).toBe(true);
    expect(cases.every((c) => c.tree.plan && c.tree.build && c.tree.test && c.tree.judge)).toBe(true);
    expect(JSON.stringify(cases)).not.toContain("SHOULD-NOT-LEAK");
    expect(cases.find((c) => c.source_host === "github.com")?.lane).toBe("code-repository");
    expect(cases.find((c) => c.source_host === "transitive-bs.notion.site")?.strategy).toBe("auth-handoff");
  });

  it("renders the existing agent-experience corpus format", () => {
    const corpus = renderCorpus(derivePromptCases(fixture.inventory!, 3));
    const lines = corpus.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.split("|").length === 2)).toBe(true);
    expect(corpus).not.toContain("?");
    expect(corpus).not.toContain("/path");
  });

  it("builds canonical dry-run CLI plans for every generated prompt", () => {
    const cases = derivePromptCases(fixture.inventory!, 3);
    const plan = buildCliPlan(cases);
    expect(validateCliPlan(plan)).toEqual([]);
    expect(plan).toHaveLength(3);
    expect(plan[0].argv.slice(0, 3)).toEqual(["unbrowse", "read", "resolve"]);
    expect(plan.every((item) => item.argv.includes("--json"))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("SHOULD-NOT-LEAK");
  });
});

describe("bookmark prompt harness CLI", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "unbrowse-bookmark-harness-"));
    const fixturePath = join(dir, "inventory.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        ok: true,
        sources_scanned: ["dia:/fixture"],
        inventory: {
          "github.com": { fresh_cookie: true, visit_count: 100, likely_logged_in_score: 0.9 },
          "docs.getfoundry.app": { visit_count: 80, likely_logged_in_score: 0.3 },
          "transitive-bs.notion.site": { bookmarked: true, likely_logged_in_score: 0.1 },
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes corpus and cases, then selftests the local contract surface", () => {
    const outPath = join(dir, "corpus.txt");
    const casesPath = join(dir, "cases.json");
    const fixturePath = join(dir, "inventory.json");
    const res = spawnSync(
      "bun",
      [
        "scripts/bookmark-prompt-harness.ts",
        "--inventory-fixture",
        fixturePath,
        "--out",
        outPath,
        "--cases",
        casesPath,
        "--limit",
        "3",
        "--selftest",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, UNBROWSE_NO_SWEEP: "1" },
        encoding: "utf8",
      },
    );
    expect(res.status).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(casesPath)).toBe(true);
    const summary = JSON.parse(res.stdout);
    expect(summary.ok).toBe(true);
    expect(summary.case_count).toBe(3);
    expect(summary.plan_count).toBe(3);
    const casesFile = JSON.parse(readFileSync(casesPath, "utf8"));
    expect(casesFile.sources_scanned).toEqual(["dia:/fixture"]);
    expect(casesFile.cases[0].command).toEqual(["read", "resolve"]);
    expect(casesFile.cli_plan[0].argv.slice(0, 3)).toEqual(["unbrowse", "read", "resolve"]);
    expect(casesFile.cli_plan[0].expected_contract).toBe("CapabilityResult");
  });
});
