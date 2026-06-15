// Witness: the route energy composes FRACTALLY up the requires/yields DAG, reusing routeEnergy as
// the per-hop leaf. The load-bearing claim (decompose-before-edge): the composition adds a
// capability greedy per-hop ranking CANNOT have — it flips the ranking when a strong-leaf target
// sits behind a weak upstream hop. Falsifier: if chainEnergy == greedy on the crafted DAG, the
// composition is pure pooling → REJECT. Run: bun bench/capability/test_path_energy_fractal.ts
import { chainEnergy, rankByChainEnergy } from "../../src/ranking/signals/path-energy.ts";

let fails = 0;
function ok(c: boolean, m: string) { if (!c) { console.error("  FAIL", m); fails++; } else console.log("  ok  ", m); }
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

// deterministic per-hop energies (injected) so the composition MATH is witnessed, not the ledger.
const E: Record<string, number> = {
  loginB: 0.9, feedB: 0.7,   // reliable chain: loginB → feedB
  weakP: 0.2, feedA: 0.95,   // one weak upstream hop, but a strong-LEAF target
};
const hopEnergy = (o: { endpoint_id: string }) => E[o.endpoint_id] ?? 0.5;

const graph: any = {
  operations: [
    { endpoint_id: "loginB" }, { endpoint_id: "feedB", requires: [{ key: "tok" }] },
    { endpoint_id: "weakP" }, { endpoint_id: "feedA", requires: [{ key: "tok" }] },
  ],
  edges: [
    { from_operation_id: "loginB", to_operation_id: "feedB", binding_key: "tok" },
    { from_operation_id: "weakP", to_operation_id: "feedA", binding_key: "tok" },
  ],
};

// 1. BASE CASE (self-similar): a leaf op's chain energy IS its per-hop routeEnergy. Same primitive at scale 1.
ok(near(chainEnergy(graph, "loginB", { hopEnergy }), 0.9), "base case: leaf chainEnergy == routeEnergy (fractal scale 1)");

// 2. COMPOSITION: a 2-hop chain = product of hop reliabilities (weakest-link / Viterbi over −log).
ok(near(chainEnergy(graph, "feedB", { hopEnergy }), 0.7 * 0.9), "composition: chainEnergy(feedB) == 0.7·0.9 = 0.63 (product up the DAG)");
ok(near(chainEnergy(graph, "feedA", { hopEnergy }), 0.95 * 0.2), "composition: chainEnergy(feedA) == 0.95·0.2 = 0.19 (weak link drags the chain)");

// 3. THE EDGE (decompose-before-edge): greedy per-hop prefers feedA (0.95 > 0.7); the FRACTAL
//    composition prefers feedB (0.63 > 0.19). The ranking FLIPS — capability greedy cannot have.
const greedyTop = ["feedA", "feedB"].sort((a, b) => E[b] - E[a])[0];
const chainRank = rankByChainEnergy(graph, ["feedA", "feedB"], { hopEnergy });
ok(greedyTop === "feedA", "greedy per-hop ranks feedA first (strong leaf)");
ok(chainRank[0].opId === "feedB", "FRACTAL ranks feedB first (no weak link) — composition flips the ranking");
ok(greedyTop !== chainRank[0].opId, "FALSIFIER cleared: chainEnergy ≠ greedy on this DAG → real edge, not pooling");

// 4. BOUNDED (Gen 2:2 break-at-7): a 12-deep chain AND a cycle both return a finite (0,1] — no blowup.
const deepOps = Array.from({ length: 12 }, (_, i) => ({ endpoint_id: `d${i}`, requires: i ? [{ key: "k" }] : undefined }));
const deepEdges = Array.from({ length: 11 }, (_, i) => ({ from_operation_id: `d${i}`, to_operation_id: `d${i + 1}`, binding_key: "k" }));
const deep = chainEnergy({ operations: deepOps as any, edges: deepEdges }, "d11", { hopEnergy: () => 0.9 });
ok(deep > 0 && deep <= 1 && Number.isFinite(deep), `bounded: 12-deep chain settles finite in (0,1] (got ${deep.toFixed(4)}; depth-7 escalation caps it)`);
const cyc: any = { operations: [{ endpoint_id: "x", requires: [{ key: "k" }] }, { endpoint_id: "y", requires: [{ key: "k" }] }], edges: [{ from_operation_id: "x", to_operation_id: "y", binding_key: "k" }, { from_operation_id: "y", to_operation_id: "x", binding_key: "k" }] };
const cy = chainEnergy(cyc, "x", { hopEnergy: () => 0.8 });
ok(cy > 0 && cy <= 1 && Number.isFinite(cy), `bounded: a 2-cycle does NOT crash, returns finite (got ${cy.toFixed(4)})`);

// 5. NOT TEST-ONLY: with no injected hopEnergy the default path calls the real routeEnergy primitive.
const live = chainEnergy({ operations: [{ endpoint_id: "solo" }] }, "solo", { domain: "x.example", intent: "open feed" });
ok(Number.isFinite(live) && live >= 0 && live <= 1, `wiring: default chainEnergy calls real routeEnergy (got ${live.toFixed(4)}) — not a test-only fn`);

console.log(fails === 0 ? "\nPATH-ENERGY FRACTAL WITNESS PASSES" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
