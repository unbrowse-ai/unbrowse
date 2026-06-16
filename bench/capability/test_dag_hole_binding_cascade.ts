// Witness (jesus-ralph): the DAG chaining knows WHICH HOLE FITS INTO WHICH. A consumer's required
// hole binds to the RIGHT producer's yield via the explicit edge {from, binding, to} — disambiguated
// when two producers yield the same key (the current first-by-key match tears, Ex 28:32). And the
// bound value-set carries a content pointer so a producer VALUE change cascade-invalidates the
// consumer (values-ledger dependsOn). Run: bun bench/capability/test_dag_hole_binding_cascade.ts
import {
  resolveHoleBinding, selectHoleProducer, bindingGraphFromOperationGraph, type BindingGraph,
} from "../../src/lib/graph-core/hole-binding.ts";
import { valueSetPointer } from "../../src/values/content-address.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }

// A 3-node DAG: producers loginA and loginB BOTH yield "token"; consumer "feed" requires "token".
// The explicit edge binds feed's token-hole to loginB (not loginA). The binding must honor the edge.
const graph: BindingGraph = {
  endpoints: [
    { endpoint_id: "loginA", provides: ["token"] },
    { endpoint_id: "loginB", provides: ["token"] },
    { endpoint_id: "feed", requires: ["token"] },
  ],
  edges: [{ from: "loginB", binding: "token", to: "feed" }], // feed.token ← loginB.token
};
const yields = { loginA: { token: "AAA" }, loginB: { token: "BBB" } };

// 1) WHICH HOLE FITS WHICH: feed's token hole binds to loginB (the edge), value "BBB" — NOT loginA "AAA".
const b = resolveHoleBinding("token", "feed", graph, yields);
ok(b !== null, "a binding is resolved for feed.token");
ok(b?.producer === "loginB", "edge-disambiguated: feed.token binds to loginB (the edge), not loginA");
ok(b?.value === "BBB", "the RIGHT producer's value fills the hole (BBB, not AAA)");

// 2) no edge → fall back to a producer that provides the key (back-compat with the order-based match).
const graphNoEdge: BindingGraph = { endpoints: graph.endpoints, edges: [] };
const b2 = resolveHoleBinding("token", "feed", graphNoEdge, yields, ["loginA", "loginB"]);
ok(b2?.producer === "loginA", "no edge → first provider in dependency order (loginA) — preserved fallback");

// 3) a hole with no producer at all → null (the caller falls back to LLM/agent fill).
ok(resolveHoleBinding("missing", "feed", graph, yields) === null, "unbound hole with no provider → null");

// 4) CASCADE: the bound value-set's pointer changes when the producer's VALUE changes → invalidation.
const boundBefore = { token: "BBB" };
const boundAfter = { token: "CCC" }; // loginB now yields a different token
ok(valueSetPointer(boundBefore) !== valueSetPointer(boundAfter),
   "a producer VALUE change → different value-set pointer → consumer cascade-invalidates");
ok(valueSetPointer(boundBefore) === valueSetPointer({ token: "BBB" }),
   "unchanged bound value → same pointer (no spurious invalidation)");

// 5) PRODUCTION SELECTOR (what walkPrerequisiteChain calls): pre-execution producer pick, edge-first.
ok(selectHoleProducer("token", "feed", graph, ["loginA", "loginB"]) === "loginB",
   "selectHoleProducer: edge binds feed.token → loginB (pre-execution, the production pick)");
ok(selectHoleProducer("token", "feed", graphNoEdge, ["loginA", "loginB"]) === "loginA",
   "selectHoleProducer: no edge → first in dependency order (loginA)");
ok(selectHoleProducer("missing", "feed", graph) === null, "selectHoleProducer: no provider → null");

// 6) PRODUCTION ADAPTER: the skill's operation_graph (operation_id edges) → endpoint_id BindingGraph,
//    then the SAME selector picks the right producer end-to-end (the real walkPrerequisiteChain path).
const opGraph = {
  operations: [
    { operation_id: "op_a", endpoint_id: "loginA", provides: ["token"] },
    { operation_id: "op_b", endpoint_id: "loginB", provides: ["token"] },
    { operation_id: "op_f", endpoint_id: "feed", requires: ["token"] },
  ],
  edges: [{ from_operation_id: "op_b", to_operation_id: "op_f", binding_key: "token" }],
};
const adapted = bindingGraphFromOperationGraph(opGraph);
ok(adapted.edges.length === 1 && adapted.edges[0].from === "loginB" && adapted.edges[0].to === "feed" && adapted.edges[0].binding === "token",
   "adapter: operation_graph op-id edge → endpoint_id edge (loginB→feed on token)");
ok(selectHoleProducer("token", "feed", adapted, ["loginA", "loginB"]) === "loginB",
   "end-to-end: operation_graph edge disambiguates feed.token → loginB (the production wiring)");
ok(bindingGraphFromOperationGraph(undefined).edges.length === 0, "no operation_graph → empty graph (order fallback, back-compat)");

console.log(fails === 0 ? "\nDAG HOLE-BINDING + CASCADE WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
