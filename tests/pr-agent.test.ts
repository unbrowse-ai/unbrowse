import { describe, expect, it } from "bun:test";
import { evaluateMergeReadiness, summarizeCheckRuns } from "../scripts/pr-agent";

describe("pr-agent merge gating", () => {
  it("summarizes only external checks", () => {
    const summary = summarizeCheckRuns([
      { name: "Review And Repair PR", status: "completed", conclusion: "failure" },
      { name: "Unit Tests", status: "completed", conclusion: "success" },
      { name: "CLI E2E", status: "in_progress", conclusion: null },
      { name: "Quality Gate", status: "completed", conclusion: "failure" },
    ]);

    expect(summary.hasExternalChecks).toBe(true);
    expect(summary.pending).toEqual(["CLI E2E"]);
    expect(summary.failing).toEqual(["Quality Gate"]);
    expect(summary.successful).toEqual(["Unit Tests"]);
  });

  it("blocks merge when requested changes or pending checks remain", () => {
    const readiness = evaluateMergeReadiness(
      {
        state: "OPEN",
        isDraft: false,
        reviewDecision: "CHANGES_REQUESTED",
        mergeStateStatus: "BLOCKED",
        headRefOid: "abc123",
      },
      "abc123",
      [{ name: "Unit Tests", status: "in_progress", conclusion: null }],
    );

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toContain("review requested changes");
  });

  it("allows merge only when non-agent checks are green and merge state is safe", () => {
    const readiness = evaluateMergeReadiness(
      {
        state: "OPEN",
        isDraft: false,
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        headRefOid: "abc123",
      },
      "abc123",
      [
        { name: "Review And Repair PR", status: "completed", conclusion: "success" },
        { name: "Unit Tests", status: "completed", conclusion: "success" },
        { name: "CLI E2E", status: "completed", conclusion: "success" },
      ],
    );

    expect(readiness.ok).toBe(true);
    expect(readiness.successfulChecks).toEqual(["Unit Tests", "CLI E2E"]);
  });
});
