import { test, expect } from "bun:test";
import { rankEndpointsServer, type RankRequest } from "../src/services/rank";

// Creatures/abundance: the rank route now accepts a CLIENT-SUPPLIED operation_graph (untrusted). A
// hostile or malformed graph must never crash rankEndpointsServer or pin the Worker isolate. The one
// sheep worth finding: an oversized graph (O(N·E) composition could hang). Probe + measure, then gate.

function ep(id: string, reliability = 0.5): any {
  return {
    endpoint_id: id, method: "GET", url_template: `https://shop.example/${id}`,
    idempotency: "idempotent", verification_status: "verified", reliability_score: reliability,
  };
}
const base = (operation_graph: any): RankRequest =>
  ({ intent: "list orders", skill_domain: "shop.example", endpoints: [ep("orders"), ep("cart")], operation_graph });

test("GOLDEN: a valid small graph ranks without error", () => {
  const g = { operations: [{ endpoint_id: "orders", requires: [{ key: "t" }] }, { endpoint_id: "login" }], edges: [{ from_operation_id: "login", to_operation_id: "orders", binding_key: "t" }] };
  expect(rankEndpointsServer(base(g)).degraded).toBe(false);
});

test("EDGE: a CYCLIC graph does not hang or throw (visited-set bounds it)", () => {
  const g = {
    operations: [{ endpoint_id: "orders", requires: [{ key: "t" }] }, { endpoint_id: "cart", requires: [{ key: "t" }] }],
    edges: [
      { from_operation_id: "orders", to_operation_id: "cart", binding_key: "t" },
      { from_operation_id: "cart", to_operation_id: "orders", binding_key: "t" },
    ],
  };
  expect(() => rankEndpointsServer(base(g))).not.toThrow();
});

test("EDGE: MALFORMED graphs (null/garbage shapes) never throw — chain just doesn't apply", () => {
  for (const bad of [null, {}, { operations: null }, { operations: "x" }, { operations: [{}] }, { operations: [{ endpoint_id: "orders" }], edges: "nope" }]) {
    expect(() => rankEndpointsServer(base(bad as any))).not.toThrow();
  }
});

test("EDGE: edges to NONEXISTENT ops / self-loops don't throw", () => {
  const g = {
    operations: [{ endpoint_id: "orders", requires: [{ key: "t" }] }],
    edges: [
      { from_operation_id: "ghost", to_operation_id: "orders", binding_key: "t" },
      { from_operation_id: "orders", to_operation_id: "orders", binding_key: "t" },
    ],
  };
  expect(() => rankEndpointsServer(base(g))).not.toThrow();
});

test("ADVERSARIAL: an OVERSIZED graph (5000 ops, 5000 edges, deep chain) completes fast (no isolate pin)", () => {
  const ops = Array.from({ length: 5000 }, (_, i) => ({ endpoint_id: `n${i}`, requires: i ? [{ key: "t" }] : undefined }));
  // a deep linear chain ending at "orders" so the consumer's prerequisite walk is maximal
  const edges = Array.from({ length: 4999 }, (_, i) => ({ from_operation_id: `n${i}`, to_operation_id: `n${i + 1}`, binding_key: "t" }));
  ops.push({ endpoint_id: "orders", requires: [{ key: "t" }] });
  edges.push({ from_operation_id: "n4999", to_operation_id: "orders", binding_key: "t" });
  const req = base({ operations: ops, edges });
  const t0 = performance.now();
  expect(() => rankEndpointsServer(req)).not.toThrow();
  const ms = performance.now() - t0;
  // Worker isolate budget: a single rank must stay well under a request timeout. 250ms is generous;
  // if this fails the composition is unbounded and needs a server-side size cap.
  expect(ms).toBeLessThan(250);
});
