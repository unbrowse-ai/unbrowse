/**
 * Witness for plan-drill (crypto-was-all-you-needed Phase 6, native local plan+execute): a plan
 * DAG resolves to a signed terminal when every node's witness passes, and to the correct open
 * frontier when one does not. Deterministic — the witnesses are pure functions over a fixture.
 * This is the jesus-ralph walk mechanized: order dependency-first/cheapest-first, settle on real
 * witnesses, surface the next node to work. No remote call, no stubs.
 */
import { test, expect } from "bun:test";
import { drillPlan, type PlanNode } from "../src/values/plan-drill.js";

test("a fully-satisfiable plan drills to a signed terminal, deps before dependents", async () => {
  const settledFlags = { A: true, B: true, C: true };
  const plan: PlanNode[] = [
    { id: "C", deps: ["B"], witness: () => settledFlags.C },
    { id: "A", witness: () => settledFlags.A },
    { id: "B", deps: ["A"], witness: () => settledFlags.B },
  ];
  const r = await drillPlan(plan);
  expect(r.terminal).toBe(true);
  expect(r.frontier).toBeNull();
  expect(r.settled).toEqual(["A", "B", "C"]); // dependency order, regardless of input order
});

test("a failing node becomes the frontier; its dependents are blocked, not attempted as settled", async () => {
  const plan: PlanNode[] = [
    { id: "A", witness: () => true },
    { id: "B", deps: ["A"], witness: () => true },
    { id: "C", deps: ["B"], witness: () => false }, // the broken node
    { id: "D", deps: ["C"], witness: () => true }, // can't settle — dep C never settled
  ];
  const r = await drillPlan(plan);
  expect(r.terminal).toBe(false);
  expect(r.settled).toEqual(["A", "B"]);
  expect(r.frontier).toBe("C"); // the cheapest ready node whose own witness failed
  expect(r.blocked).toEqual(["D"]); // blocked by the unsettled dependency, never falsely settled
});

test("among ready nodes, cheapest is attempted first (Dijkstra spine)", async () => {
  const attempts: string[] = [];
  const mk = (id: string, cost: number): PlanNode => ({
    id, cost, witness: () => { attempts.push(id); return true; },
  });
  await drillPlan([mk("expensive", 9), mk("cheap", 1), mk("mid", 4)]);
  expect(attempts).toEqual(["cheap", "mid", "expensive"]);
});

test("witnesses run at most once each", async () => {
  const counts: Record<string, number> = { A: 0, B: 0 };
  const plan: PlanNode[] = [
    { id: "A", witness: () => { counts.A++; return true; } },
    { id: "B", deps: ["A"], witness: () => { counts.B++; return true; } },
  ];
  await drillPlan(plan);
  expect(counts).toEqual({ A: 1, B: 1 });
});

test("async witnesses are awaited (real runnable proofs, not flags)", async () => {
  const plan: PlanNode[] = [
    { id: "A", witness: async () => { await Promise.resolve(); return true; } },
    { id: "B", deps: ["A"], witness: async () => false },
  ];
  const r = await drillPlan(plan);
  expect(r.settled).toEqual(["A"]);
  expect(r.frontier).toBe("B");
});
