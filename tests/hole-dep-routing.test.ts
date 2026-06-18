// AC-P1: a request-skeleton HOLE is connected to the operation DAG — filled not from
// vault/llm but by a producer operation's yield at the layer below. This is the first
// thread of the cross-layer dep spine: the hole declares its routing edge (dep), and
// the agent-judged producer link is concrete + persistable. End-to-end (Day 6).
import { describe, it, expect } from "bun:test";
import { resolveHoleDep, routeHoles } from "../src/lib/graph-core/hole-binding.js";
import type { BindingGraph } from "../src/lib/graph-core/hole-binding.js";
import type { Hole } from "../src/capture/hole-template.js";

// feed (consumer) needs `token`; login (producer) yields it — the explicit edge binds them.
const graph: BindingGraph = {
  endpoints: [
    { endpoint_id: "login", provides: ["token"], requires: [] },
    { endpoint_id: "feed", provides: [], requires: ["token"] },
  ],
  edges: [{ from: "login", binding: "token", to: "feed" }],
};
const yields = { login: { token: "abc123" } };

const tokenHole: Hole = { location: { in: "header", name: "authorization" }, name: "token", kind: "secret", fill: "vault" };
const freeHole: Hole = { location: { in: "query", name: "q" }, name: "q", kind: "id", fill: "llm" };

describe("AC-P1 — hole ↔ DAG bridge", () => {
  it("resolveHoleDep finds the producer + value for a hole via the DAG", () => {
    const r = resolveHoleDep(tokenHole, "feed", graph, yields);
    expect(r).not.toBeNull();
    expect(r!.producer).toBe("login");
    expect(r!.value).toBe("abc123");
  });

  it("routeHoles stamps the routing edge (dep + fill=dep) and collects the fill", () => {
    const { holes, fills } = routeHoles([tokenHole, freeHole], "feed", graph, yields);
    const routed = holes.find((h) => h.name === "token")!;
    expect(routed.fill).toBe("dep");
    expect(routed.dep).toEqual({ producer: "login", binding: "token" });
    expect(fills.token).toBe("abc123");
  });

  it("leaves a hole with no producer untouched (stays vault/llm, no dep)", () => {
    const { holes, fills } = routeHoles([tokenHole, freeHole], "feed", graph, yields);
    const free = holes.find((h) => h.name === "q")!;
    expect(free.fill).toBe("llm");
    expect(free.dep).toBeUndefined();
    expect("q" in fills).toBe(false);
  });

  it("does not mutate the input holes (returns new objects)", () => {
    routeHoles([tokenHole], "feed", graph, yields);
    expect(tokenHole.fill).toBe("vault");
    expect(tokenHole.dep).toBeUndefined();
  });

  it("explicit edge disambiguates when two producers yield the same key (not torn)", () => {
    const g2: BindingGraph = {
      endpoints: [
        { endpoint_id: "loginA", provides: ["token"] },
        { endpoint_id: "loginB", provides: ["token"] },
        { endpoint_id: "feed", requires: ["token"] },
      ],
      edges: [{ from: "loginB", binding: "token", to: "feed" }],
    };
    const y2 = { loginA: { token: "WRONG" }, loginB: { token: "RIGHT" } };
    const r = resolveHoleDep(tokenHole, "feed", g2, y2);
    expect(r!.producer).toBe("loginB");
    expect(r!.value).toBe("RIGHT");
  });
});
