import { describe, expect, it } from "bun:test";
import { classifyExplorationCandidate, planSafeExploration } from "../src/capture/exploration.js";

describe("bounded capture exploration planner", () => {
  it("plans one reversible filter, pagination transition, and detail read", () => {
    const snapshot = [
      '[e1] checkbox "Show only responsive companies"',
      '[e2] link "Next page"',
      '[e3] link "Backend Software Engineer (AI Systems)"',
      '[e4] button "Apply now"',
    ].join("\n");
    expect(planSafeExploration(snapshot)).toEqual([
      expect.objectContaining({ kind: "filter", ref: "e1", action: "check" }),
      expect.objectContaining({ kind: "pagination", ref: "e2", action: "click" }),
      expect.objectContaining({ kind: "detail", ref: "e3", action: "click" }),
    ]);
  });

  it("fails closed on destructive, auth, ambiguous, and non-actionable controls", () => {
    for (const candidate of [
      { ref: "e1", role: "button", label: "Apply now" },
      { ref: "e2", role: "link", label: "Log in" },
      { ref: "e3", role: "button", label: "Delete account" },
      { ref: "e4", role: "textbox", label: "Search" },
    ]) expect(classifyExplorationCandidate(candidate)).toBeNull();
  });

  it("deduplicates refs and obeys a hard action budget", () => {
    const snapshot = '[e1] checkbox "Location filter"\n[e1] checkbox "Location filter"\n[e2] link "Next page"\n[e3] link "Senior Backend Engineer"';
    expect(planSafeExploration(snapshot, { maxActions: 2 })).toHaveLength(2);
  });
});
