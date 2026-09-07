// AC-P3: the CLI-as-harness surfaces hole candidates (incl. rejected, with reasons —
// no silent hard-exclusion), the agent maps the dep, and publish is GATED on that map.
import { describe, it, expect } from "bun:test";
import { surfaceCandidates, isHoleDetermined, publishReadiness } from "../src/lib/graph-core/hole-harness.js";
import type { BindingGraph } from "../src/lib/graph-core/hole-binding.js";
import type { Hole } from "../src/capture/hole-template.js";

const graph: BindingGraph = {
  endpoints: [
    { endpoint_id: "login", provides: ["token"] },
    { endpoint_id: "search", provides: ["query"] },      // yields something else
    { endpoint_id: "feed", requires: ["token"] },
  ],
  edges: [{ from: "login", binding: "token", to: "feed" }],
};

describe("AC-P3 — harness surfaces, agent maps, publish gated", () => {
  it("surfaces every producer — admissible AND rejected, each with a reason", () => {
    const cands = surfaceCandidates({ name: "token" }, "feed", graph);
    const login = cands.find((c) => c.producer === "login")!;
    const search = cands.find((c) => c.producer === "search")!;
    expect(login.admissible).toBe(true);
    expect(login.reason).toContain("explicit edge");
    // the non-matching producer is SURFACED (not hidden) with why it was rejected
    expect(search.admissible).toBe(false);
    expect(search.reason).toContain("does not yield");
    expect(search.reason).toContain("query");
  });

  it("does not auto-pick or hard-exclude — the consumer itself is the only omission", () => {
    const cands = surfaceCandidates({ name: "token" }, "feed", graph);
    expect(cands.map((c) => c.producer).sort()).toEqual(["login", "search"]);
  });

  it("isHoleDetermined: vault/llm runtime-fill, or fill=dep WITH a mapped edge", () => {
    expect(isHoleDetermined({ location: { in: "header", name: "a" }, name: "a", kind: "secret", fill: "vault" })).toBe(true);
    expect(isHoleDetermined({ location: { in: "query", name: "q" }, name: "q", kind: "id", fill: "llm" })).toBe(true);
    // declared producer-filled but UNMAPPED → under-determined
    expect(isHoleDetermined({ location: { in: "header", name: "t" }, name: "t", kind: "secret", fill: "dep" })).toBe(false);
    // mapped → determined
    expect(isHoleDetermined({ location: { in: "header", name: "t" }, name: "t", kind: "secret", fill: "dep", dep: { producer: "login", binding: "t" } })).toBe(true);
  });

  it("publish is REFUSED while a producer-fill hole is unmapped, ready once mapped", () => {
    const holes: Hole[] = [
      { location: { in: "query", name: "q" }, name: "q", kind: "id", fill: "llm" },
      { location: { in: "header", name: "token" }, name: "token", kind: "secret", fill: "dep" }, // unmapped
    ];
    const before = publishReadiness(holes);
    expect(before.ready).toBe(false);
    expect(before.unmapped).toEqual(["token"]);

    holes[1].dep = { producer: "login", binding: "token" }; // agent maps it
    const after = publishReadiness(holes);
    expect(after.ready).toBe(true);
    expect(after.unmapped).toEqual([]);
  });
});
