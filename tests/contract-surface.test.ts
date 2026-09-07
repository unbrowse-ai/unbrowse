/**
 * contract-surface seed test — the /contract-shaped surface SHAPE is real (declareGoal),
 * and resolveViaLedger returns a real witness shape instead of a stub.
 */
import { describe, expect, it } from "bun:test";
import { declareGoal, resolveViaLedger } from "../src/contract-surface/index.ts";

describe("contract-surface seed (the /contract-shaped union surface)", () => {
  it("declareGoal: the build/declare verb yields a neuron carrying the intent", () => {
    const n = declareGoal({ intent: "find the cheapest flight", url: "https://example.com" });
    expect(n.intent).toBe("find the cheapest flight");
    expect(n.url).toBe("https://example.com");
  });

  it("declareGoal: refuses an empty intent (no silent neuron)", () => {
    expect(() => declareGoal({ intent: "" })).toThrow(/non-empty intent/);
  });

  it("resolveViaLedger: returns a witness shape", async () => {
    const n = declareGoal({ intent: "anything" });
    const w = await resolveViaLedger(n);
    expect(typeof w.satisfied).toBe("boolean");
    expect(w.evidence).toBeTruthy();
  });
});
