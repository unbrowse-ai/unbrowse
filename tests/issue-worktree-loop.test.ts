import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeHarnessCases } from "../evals/codex-harness-lib.js";
import {
  buildFixedCodexRegressionCommand,
  buildTargetedCodexEvalCommand,
  deriveCapabilityEvalCases,
  deriveIssueEvalCases,
  extractFileMentions,
  extractUrls,
  FIXED_CODEX_REGRESSION_CASES_PATH,
  inferSuggestedCommands,
} from "../skills/worktree-issue-fix/scripts/issue-worktree-loop.ts";

describe("issue worktree loop helpers", () => {
  it("extracts urls and file mentions from issue text", () => {
    const body = `
Fix src/execution/index.ts and src/reverse-engineer/index.ts.
See https://github.com/unbrowse-ai/unbrowse/issues/70 and https://hn.algolia.com/.
`;
    expect(extractUrls(body)).toEqual([
      "https://github.com/unbrowse-ai/unbrowse/issues/70",
      "https://hn.algolia.com/",
    ]);
    expect(extractFileMentions(body)).toEqual([
      "src/execution/index.ts",
      "src/reverse-engineer/index.ts",
    ]);
  });

  it("adds cli e2e for capture/auth/browser issues", () => {
    const commands = inferSuggestedCommands([
      {
        title: "bug: LinkedIn Voyager execute fails — auth headers not replayed",
        body: "capture works, browser cookies exist, run CLI checks",
      },
    ]);

    expect(commands).toContain("bun run test:issue-regressions");
    expect(commands).toContain("bun run test");
    expect(commands).toContain("bun test tests/cli-e2e.test.ts");
  });

  it("adds cli e2e for capability asks that touch browser or pypi paths", () => {
    const commands = inferSuggestedCommands([], [
      "add better PyPI marketplace capability",
    ]);

    expect(commands).toContain("bun test tests/cli-e2e.test.ts");
  });

  it("keeps default verify commands for generic asks", () => {
    const commands = inferSuggestedCommands([
      {
        title: "docs: update readme",
        body: "polish release notes only",
      },
    ]);

    expect(commands).toEqual([
      "bun run test:issue-regressions",
      "bun run test",
    ]);
  });

  it("builds a fixed cold-warm codex regression command", () => {
    expect(buildFixedCodexRegressionCommand([69, 70, 71])).toBe(
      'bun evals/codex-autonomous-harness.ts --benchmark --cases "evals/codex-cases.worktree-regression.json" --out ".planning/issue-worktree/codex-phase-regression-69-70-71.json"',
    );
  });

  it("builds targeted codex evals with the same cold-warm harness", () => {
    expect(
      buildTargetedCodexEvalCommand({
        issues: [70],
        capabilities: [],
        evalIntent: "search hacker news",
        evalUrl: "https://hn.algolia.com/",
        evalParams: '{"q":"openai"}',
      }),
    ).toBe(
      'bun evals/codex-autonomous-harness.ts --benchmark --intent "search hacker news" --url "https://hn.algolia.com/" --out ".planning/issue-worktree/codex-targeted-eval-70.json" --params "{\\"q\\":\\"openai\\"}"',
    );
  });

  it("derives extra eval cases from issue URLs", () => {
    const cases = deriveIssueEvalCases([
      {
        title: "PyPI package detail has no runnable endpoint",
        body: "Repro on https://pypi.org/project/openai/ and also check https://pub.dev/packages/http.",
      },
    ]);

    expect(cases).toEqual([
      {
        id: "pypi-package-info-openai",
        intent: "get package info",
        url: "https://pypi.org/project/openai/",
        expected_fields: ["name", "version", "summary"],
      },
      {
        id: "pubdev-package-info-http",
        intent: "get package info",
        url: "https://pub.dev/packages/http",
        expected_fields: ["name", "version", "description"],
      },
    ]);
  });

  it("derives extra eval cases from capability asks", () => {
    const cases = deriveCapabilityEvalCases([
      "add PyPI package support",
      "make HN search more reliable",
    ]);

    expect(cases).toEqual([
      {
        id: "pypi-package-info-openai",
        intent: "get package info",
        url: "https://pypi.org/project/openai/",
        expected_fields: ["name", "version", "summary"],
      },
      {
        id: "hn-search-param-seeded",
        intent: "search hacker news",
        url: "https://hn.algolia.com/",
        params: { q: "openai" },
        expected_fields: ["title", "author", "url"],
      },
    ]);
  });

  it("keeps the fixed worktree codex case set public and task-shaped", () => {
    const raw = JSON.parse(
      readFileSync(join(import.meta.dir, "..", FIXED_CODEX_REGRESSION_CASES_PATH), "utf-8"),
    );
    const cases = normalizeHarnessCases(raw);

    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.every((testCase) => !testCase.auth)).toBe(true);
    expect(cases.every((testCase) => testCase.url.startsWith("https://"))).toBe(true);
    expect(cases.every((testCase) => testCase.expected_fields.length > 0)).toBe(true);
    expect(cases.some((testCase) => testCase.intent.startsWith("search"))).toBe(true);
    expect(cases.some((testCase) => testCase.intent === "get package info")).toBe(true);
  });
});
