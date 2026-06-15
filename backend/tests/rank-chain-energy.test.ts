import { test, expect } from "bun:test";
import { rankEndpointsServer, type RankRequest } from "../src/services/rank";

// Witness: the FRACTAL EBM chain runs server-side when the request carries an operation_graph — the
// head energy composed up the requires/yields DAG (weakest-link). Data-gated: absent graph → no chain
// signal (per-hop head used). This is the "fractal chainEnergy on the server" half of EBM-on-server.

function ep(id: string, reliability = 0.5): any {
  return {
    endpoint_id: id, method: "GET", url_template: `https://shop.example/${id}`,
    idempotency: "idempotent", verification_status: "verified", reliability_score: reliability,
  };
}
// orders REQUIRES a token produced by login (login → orders edge).
function graph(loginRel: number) {
  return {
    operations: [{ endpoint_id: "login" }, { endpoint_id: "orders", requires: [{ key: "token" }] }],
    edges: [{ from_operation_id: "login", to_operation_id: "orders", binding_key: "token" }],
  };
}
function req(loginRel: number, withGraph: boolean): RankRequest {
  return {
    intent: "list my recent orders",
    skill_domain: "shop.example",
    endpoints: [ep("login", loginRel), ep("orders", 0.9)],
    ...(withGraph ? { operation_graph: graph(loginRel) as any } : {}),
  };
}
const chainOf = (r: RankRequest, id: string) =>
  rankEndpointsServer(r).ranked.find((x) => x.endpoint_id === id)?.evidence.chain_energy;

test("data-gated: NO operation_graph → no chain_energy (per-hop head used)", () => {
  for (const r of rankEndpointsServer(req(0.5, false)).ranked) {
    expect(r.evidence.chain_energy).toBeUndefined();
  }
});

test("graph present → an op in it (that survives the noise filter) carries a numeric chain_energy", () => {
  // 'orders' is a real data endpoint; 'login' is auth/session-plumbing and is noise-filtered out of
  // the ranked pool, so we assert on 'orders' (the consumer) — it composes over its login prerequisite.
  expect(typeof chainOf(req(0.5, true), "orders")).toBe("number");
});

test("WEAKEST-LINK: a weak prerequisite drags the consumer's chain energy down", () => {
  // orders has reliability 0.9 in both, but its prerequisite login is weak (0.05) vs strong (0.95).
  const weak = chainOf(req(0.05, true), "orders")!;
  const strong = chainOf(req(0.95, true), "orders")!;
  expect(weak).toBeLessThan(strong); // the chain is only as reliable as its weakest hop — fractal composition
});

test("reliability stays PRIMARY even with the chain signal active", () => {
  // a proven endpoint (rel 1.0) with no weak prerequisite must outrank a cold one regardless of chain bound (±8).
  const r: RankRequest = {
    intent: "x", skill_domain: "shop.example",
    endpoints: [ep("cold", 0.0), ep("proven", 1.0)],
    operation_graph: { operations: [{ endpoint_id: "cold" }, { endpoint_id: "proven" }], edges: [] } as any,
  };
  expect(rankEndpointsServer(r).ranked[0].endpoint_id).toBe("proven");
});

test("deterministic with a graph: same request twice → identical scores", () => {
  const a = rankEndpointsServer(req(0.3, true)).ranked.map((r) => [r.endpoint_id, r.score] as const);
  const b = rankEndpointsServer(req(0.3, true)).ranked.map((r) => [r.endpoint_id, r.score] as const);
  expect(a).toEqual(b);
});
