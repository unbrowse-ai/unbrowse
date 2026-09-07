/**
 * Spine alias: workflow witness names this file operation-circ.test.ts.
 * Implementation module is operation-tour (TSP residual over op graph).
 * Keep both filenames green for harness + human discoverability.
 */
import { describe, expect, it } from "bun:test";
import {
  operationTransitionCost,
  orderOperationTour,
} from "../src/values/operation-tour.js";

describe("operation-circ (alias of operation-tour)", () => {
  it("prefers forward dependency edges", () => {
    const edges = [
      { from_operation_id: "search", to_operation_id: "detail", kind: "dependency" },
      { from_operation_id: "detail", to_operation_id: "buy", kind: "dependency" },
    ];
    const rel = new Map([
      ["search", 0.9],
      ["detail", 0.8],
      ["buy", 0.7],
    ]);
    expect(operationTransitionCost("search", "detail", edges, rel)).toBe(1);
    expect(operationTransitionCost("detail", "search", edges, rel)).toBe(100);
    expect(operationTransitionCost("search", "buy", edges, rel)).toBeGreaterThan(1);
  });

  it("orders a chain along dependency edges", () => {
    const { order, cost } = orderOperationTour({
      operations: [
        { operation_id: "search", reliability_score: 0.9 },
        { operation_id: "detail", reliability_score: 0.8 },
        { operation_id: "buy", reliability_score: 0.5 },
      ],
      edges: [
        { from_operation_id: "search", to_operation_id: "detail", kind: "dependency" },
        { from_operation_id: "detail", to_operation_id: "buy", kind: "dependency" },
      ],
      start: "search",
    });
    expect(order).toEqual(["search", "detail", "buy"]);
    expect(cost).toBeLessThan(20);
  });

  it("include filter restricts the tour", () => {
    const { order } = orderOperationTour({
      operations: [
        { operation_id: "a" },
        { operation_id: "b" },
        { operation_id: "c" },
      ],
      include: ["a", "c"],
      start: "a",
    });
    expect(order).toEqual(["a", "c"]);
  });
});
