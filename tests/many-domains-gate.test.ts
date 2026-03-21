import { describe, expect, it } from "bun:test";
import { evaluateManyDomainsGate } from "../scripts/eval-many-domains-gate.ts";

describe("many domains gate", () => {
  it("passes when corpus breadth and satisfied count clear the floor", () => {
    const suite = {
      cases: Array.from({ length: 12 }, (_, index) => ({
        id: `case-${index}`,
        intent: `intent-${index % 6}`,
        url: `https://host-${index}.example.com/path`,
      })),
    };
    const results = {
      results: Array.from({ length: 12 }, (_, index) => ({
        id: `case-${index}`,
        final_state: index < 8 ? "pass" : "fail",
        goal_satisfied: index < 8,
        final_reason: index < 8 ? "pass" : "fail",
      })),
    };

    const evaluation = evaluateManyDomainsGate(suite, results);
    expect(evaluation.ok).toBe(true);
    expect(evaluation.satisfied_cases).toBe(8);
    expect(evaluation.distinct_hosts).toBe(12);
    expect(evaluation.distinct_intents).toBe(6);
  });

  it("fails when suite is too narrow", () => {
    const suite = {
      cases: Array.from({ length: 4 }, (_, index) => ({
        id: `case-${index}`,
        intent: "search docs",
        url: `https://docs-${index}.example.com`,
      })),
    };
    const results = {
      results: Array.from({ length: 4 }, (_, index) => ({
        id: `case-${index}`,
        final_state: "pass",
        goal_satisfied: true,
        final_reason: "pass",
      })),
    };

    const evaluation = evaluateManyDomainsGate(suite, results);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.map((failure) => failure.code)).toContain("too_few_cases");
    expect(evaluation.failures.map((failure) => failure.code)).toContain("too_few_hosts");
    expect(evaluation.failures.map((failure) => failure.code)).toContain("too_few_intents");
  });

  it("fails when satisfied rate collapses", () => {
    const suite = {
      cases: Array.from({ length: 12 }, (_, index) => ({
        id: `case-${index}`,
        intent: `intent-${index % 5}`,
        url: `https://host-${index}.example.com/path`,
      })),
    };
    const results = {
      results: Array.from({ length: 12 }, (_, index) => ({
        id: `case-${index}`,
        final_state: index < 5 ? "pass" : "fail",
        goal_satisfied: index < 5,
        final_reason: index < 5 ? "pass" : "fail",
      })),
    };

    const evaluation = evaluateManyDomainsGate(suite, results);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.failures.map((failure) => failure.code)).toContain("satisfied_floor");
    expect(evaluation.failures.map((failure) => failure.code)).toContain("satisfied_ratio");
    expect(evaluation.failures.map((failure) => failure.code)).toContain("too_many_unsatisfied");
  });
});
