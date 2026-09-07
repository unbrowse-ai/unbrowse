import { describe, expect, test } from "bun:test";
import { stableVectorId } from "../src/values/contract-everything.js";

/**
 * Witness for the emergentdb SDK-correctness fix (dug from the emergentdb-js SDK +
 * arch-clarification doc): EmergentDB's VectorEntry.id is a CALLER-supplied positive int
 * (hash skill_id:endpoint_id → positive int), NOT an emergent-assigned id. So the vector id
 * must be a deterministic, positive, safe integer derived from our contract id — which makes
 * inserts idempotent upserts and removes the self-search round-trip. The prior code hardcoded
 * id:1 (every vector collided) and self-searched on a wrong "emergent assigns the id" assumption.
 */
describe("stableVectorId — caller-owned positive-int vector id (emergentdb SDK contract)", () => {
  test("deterministic: same contract id → same vector id", () => {
    const a = stableVectorId("route:reddit:hot:abcdef");
    const b = stableVectorId("route:reddit:hot:abcdef");
    expect(a).toBe(b);
  });

  test("positive safe integer (VectorEntry.id is .positive())", () => {
    for (const id of ["route:x", "route:y", "contract:abc", "amen-1", ""]) {
      const n = stableVectorId(id);
      expect(Number.isSafeInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(2 ** 53);
    }
  });

  test("distinct contract ids → distinct vector ids (no id:1 collision)", () => {
    const ids = ["route:a", "route:b", "route:c", "route:d", "route:e"];
    const mapped = new Set(ids.map(stableVectorId));
    expect(mapped.size).toBe(ids.length);
  });
});
