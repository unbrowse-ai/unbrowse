/**
 * Witness: a routing decision renders as the native /contract three-shape and drills to a
 * signed terminal ONLY when it genuinely interpreted → verified → adjudicated. This is the
 * routing layer expressed in the substrate's own shape (the step toward "/contract embedded
 * native" at the routing layer), settled on real witnesses via the in-process plan-drill engine.
 */
import { test, expect } from "bun:test";
import { resolutionAsContractDrill, resolutionContractVerdict } from "../src/values/resolution-contract.js";

test("a full resolution drills to a signed three-shape terminal", async () => {
  const d = await resolutionAsContractDrill({
    intent: "list top posts in r/programming",
    route: { url: "https://www.reddit.com/r/programming.json", skill_id: "Zr9kQ2pLmN3xY7vBcD1aF" },
    winner: { endpoints: [{ endpoint_id: "ep-listing" }] },
  });
  expect(d.terminal).toBe(true);
  expect(d.settled).toEqual(["interpret", "verify", "adjudicate"]);
  expect(d.frontier).toBeNull();
});

test("a resolution with no adjudicated winner stops at the adjudicate frontier", async () => {
  const d = await resolutionAsContractDrill({
    intent: "find the listing endpoint",
    route: { url: "https://example.com/api" },
    winner: null,
  });
  expect(d.terminal).toBe(false);
  expect(d.settled).toEqual(["interpret", "verify"]);
  expect(d.frontier).toBe("adjudicate");
});

test("no route → verify fails and adjudicate is blocked (not falsely settled)", async () => {
  const d = await resolutionAsContractDrill({ intent: "anything", route: null, winner: null });
  expect(d.terminal).toBe(false);
  expect(d.settled).toEqual(["interpret"]);
  expect(d.frontier).toBe("verify");
  expect(d.blocked).toContain("adjudicate");
});

test("empty intent fails at interpret — the whole shape is blocked", async () => {
  const d = await resolutionAsContractDrill({ intent: "   ", route: { url: "x" }, winner: { endpoints: [1] } });
  expect(d.terminal).toBe(false);
  expect(d.frontier).toBe("interpret");
  expect(d.blocked.sort()).toEqual(["adjudicate", "verify"]);
});

// The native bridge the live CLI resolve path calls (cli.ts attaches its return as result._contract).
test("resolutionContractVerdict: a resolved skill with endpoints is terminal", async () => {
  const v = await resolutionContractVerdict({
    intent: "list top posts in r/programming",
    skill: { skill_id: "Zr9kQ2pLmN3xY7vBcD1aF", endpoints: [{ endpoint_id: "ep-listing" }] },
  });
  expect(v.terminal).toBe(true);
  expect(v.settled).toEqual(["interpret", "verify", "adjudicate"]);
  expect(v.frontier).toBeNull();
});

test("resolutionContractVerdict: a skill_id with no endpoints stops at adjudicate", async () => {
  const v = await resolutionContractVerdict({ intent: "find listing", skill: { skill_id: "abc", endpoints: [] } });
  expect(v.terminal).toBe(false);
  expect(v.frontier).toBe("adjudicate");
});

test("resolutionContractVerdict: no skill → verify is the frontier (route unproven)", async () => {
  const v = await resolutionContractVerdict({ intent: "anything", skill: null });
  expect(v.terminal).toBe(false);
  expect(v.frontier).toBe("verify");
});

test("resolutionContractVerdict: empty intent → interpret frontier (fail-open, never throws)", async () => {
  const v = await resolutionContractVerdict({ intent: "  ", skill: { skill_id: "x", endpoints: [1] } });
  expect(v.terminal).toBe(false);
  expect(v.frontier).toBe("interpret");
});
