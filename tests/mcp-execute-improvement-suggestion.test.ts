// AC5 : lane-07: improvement_suggestion on failed-intent responses.
//
// The helper enrichWithImprovementSuggestion(response, coveragePath?) reads the
// coverage.jsonl ledger (UNBROWSE_COVERAGE_LEDGER_PATH or explicit arg) and
// merges an improvement_suggestion field into responses where:
//   (a) intent_status is "failed" or "partial"           [reflect]
//   (b) success === false and error_code matches a known
//       canonical failure mode in the ledger             [execute]
//
// No hard-coded mapping: the ledger declares what each failure means.
// If no matching row exists, improvement_suggestion is null (never fabricated).

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { enrichWithImprovementSuggestion, clearCoverageCache } from "../src/mcp-improvement-suggestion";

let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "ac5-ledger-"));
  ledgerPath = path.join(tmpDir, "coverage.jsonl");
  clearCoverageCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  clearCoverageCache();
});

function writeLedger(rows: Array<Record<string, unknown>>): void {
  const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(ledgerPath, lines, "utf8");
}

describe("enrichWithImprovementSuggestion", () => {
  it("adds improvement_suggestion to execute response when error_code matches a ledger row", () => {
    writeLedger([
      {
        ts: "2026-05-16",
        named_regression: "4xx_live_session_fallback_no_session/active_domains-empty-strings",
        files_changed: ["src/api/browse-session.ts", "src/execution/index.ts", "tests/foo.test.ts", "CHANGELOG.md"],
      },
    ]);

    const response = {
      success: false,
      error_code: "4xx_live_session_fallback_no_session",
      error: "no active session",
    };

    const enriched = enrichWithImprovementSuggestion(response, ledgerPath);
    expect(enriched.improvement_suggestion).toBeDefined();
    const sug = enriched.improvement_suggestion as Record<string, unknown>;
    expect(sug.named_regression).toContain("4xx_live_session_fallback_no_session");
    const fixSurface = sug.candidate_fix_surface as string[];
    expect(Array.isArray(fixSurface)).toBe(true);
    expect(fixSurface).toContain("src/api/browse-session.ts");
    expect(fixSurface).toContain("src/execution/index.ts");
    const nextAction = sug.next_action as Record<string, unknown>;
    expect(nextAction.tool).toBe("unbrowse_diagnose");
    expect((nextAction.args as Record<string, unknown>).named_regression).toBe(sug.named_regression);
  });

  it("returns improvement_suggestion: null when no ledger row matches the failure mode", () => {
    writeLedger([
      {
        ts: "2026-05-16",
        named_regression: "some_unrelated_regression",
        files_changed: ["src/elsewhere.ts"],
      },
    ]);

    const response = {
      success: false,
      error_code: "stale_endpoint",
    };

    const enriched = enrichWithImprovementSuggestion(response, ledgerPath);
    expect(enriched.improvement_suggestion).toBeNull();
  });

  it("adds improvement_suggestion to reflect response with intent_status: failed", () => {
    writeLedger([
      {
        ts: "2026-05-16",
        named_regression: "endpoint_not_found in workflow DAG",
        files: ["src/orchestrator/index.ts"],
      },
    ]);

    const response = {
      ok: true,
      recorded: true,
      intent_status: "failed",
      // simulate that the calling context knows the failure mode label
      failure_mode: "endpoint_not_found",
    };

    const enriched = enrichWithImprovementSuggestion(response, ledgerPath);
    const sug = enriched.improvement_suggestion as Record<string, unknown>;
    expect(sug).toBeDefined();
    expect(sug.named_regression).toContain("endpoint_not_found");
    expect(sug.candidate_fix_surface as string[]).toContain("src/orchestrator/index.ts");
  });

  it("returns response unchanged (no improvement_suggestion key) on success: true", () => {
    writeLedger([
      {
        ts: "2026-05-16",
        named_regression: "stale_endpoint regression",
        files_changed: ["src/foo.ts"],
      },
    ]);

    const response = { success: true, data: [1, 2, 3] };
    const enriched = enrichWithImprovementSuggestion(response, ledgerPath);
    expect("improvement_suggestion" in enriched).toBe(false);
  });

  it("handles missing ledger file gracefully (returns response unchanged)", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.jsonl");
    const response = { success: false, error_code: "stale_endpoint" };
    const enriched = enrichWithImprovementSuggestion(response, missingPath);
    expect(enriched.improvement_suggestion).toBeNull();
  });

  it("respects UNBROWSE_COVERAGE_LEDGER_PATH env var when no path arg passed", () => {
    writeLedger([
      {
        ts: "2026-05-16",
        named_regression: "stale_endpoint cached past TTL",
        files_changed: ["src/cache/index.ts"],
      },
    ]);

    const prev = process.env.UNBROWSE_COVERAGE_LEDGER_PATH;
    process.env.UNBROWSE_COVERAGE_LEDGER_PATH = ledgerPath;
    try {
      clearCoverageCache();
      const response = { success: false, error_code: "stale_endpoint" };
      const enriched = enrichWithImprovementSuggestion(response);
      const sug = enriched.improvement_suggestion as Record<string, unknown>;
      expect(sug).not.toBeNull();
      expect(sug.named_regression).toContain("stale_endpoint");
      expect(sug.candidate_fix_surface as string[]).toContain("src/cache/index.ts");
    } finally {
      if (prev === undefined) delete process.env.UNBROWSE_COVERAGE_LEDGER_PATH;
      else process.env.UNBROWSE_COVERAGE_LEDGER_PATH = prev;
    }
  });

  it("filters candidate_fix_surface to src/ paths (drops CHANGELOG.md, tests/, etc.)", () => {
    writeLedger([
      {
        ts: "2026-05-16",
        named_regression: "payload_exceeded_wire_budget_after_diet structural loss",
        files_changed: [
          "CHANGELOG.md",
          "src/mcp.ts",
          "tests/foo.test.ts",
          "src/diet/budget.ts",
        ],
      },
    ]);

    const response = { success: false, error_code: "payload_exceeded_wire_budget_after_diet" };
    const enriched = enrichWithImprovementSuggestion(response, ledgerPath);
    const sug = enriched.improvement_suggestion as Record<string, unknown>;
    const fixSurface = sug.candidate_fix_surface as string[];
    expect(fixSurface).toContain("src/mcp.ts");
    expect(fixSurface).toContain("src/diet/budget.ts");
    expect(fixSurface).not.toContain("CHANGELOG.md");
    expect(fixSurface).not.toContain("tests/foo.test.ts");
  });
});
