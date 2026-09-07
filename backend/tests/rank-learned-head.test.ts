import { test, expect } from "bun:test";
import { rankEndpointsServer, type RankRequest } from "../src/services/rank";

// Witness: the EBM learned head runs INSIDE the worker ranker (rankEndpointsServer), fed by the
// durable identity-free (domain,endpoint) signal — additive, bounded, non-regressive. This is the
// "EBM on the server" delta: the head was client-only before.

function ep(id: string, reliability = 0.5): any {
  return {
    endpoint_id: id,
    method: "GET",
    url_template: `https://shop.example/${id}`,
    idempotency: "idempotent",
    verification_status: "verified",
    reliability_score: reliability,
  };
}

test("learned head RUNS server-side: every result carries a numeric learned_energy", () => {
  const req: RankRequest = {
    intent: "list my recent orders",
    skill_domain: "shop.example",
    endpoints: [ep("orders"), ep("logout"), ep("account-settings")],
  };
  const res = rankEndpointsServer(req);
  expect(res.degraded).toBe(false);
  for (const r of res.ranked) expect(typeof r.evidence.learned_energy).toBe("number");
});

test("the head is SHIPPED + active: at least one learned_energy is non-zero (not the no-head fallback)", () => {
  const req: RankRequest = {
    intent: "list my recent orders",
    skill_domain: "shop.example",
    endpoints: [ep("orders"), ep("logout"), ep("account-settings")],
  };
  const energies = rankEndpointsServer(req).ranked.map((r) => r.evidence.learned_energy ?? 0);
  expect(energies.some((e) => e !== 0)).toBe(true);
});

test("the head DISCRIMINATES: distinct endpoints get distinct learned_energy", () => {
  const req: RankRequest = {
    intent: "list my recent orders",
    skill_domain: "shop.example",
    endpoints: [ep("orders"), ep("logout")],
  };
  const m = new Map(rankEndpointsServer(req).ranked.map((r) => [r.endpoint_id, r.evidence.learned_energy ?? 0]));
  expect(m.get("orders")).not.toBe(m.get("logout"));
});

test("reliability stays PRIMARY: a full reliability gap is never overturned by the learned head", () => {
  const req: RankRequest = {
    intent: "anything",
    skill_domain: "shop.example",
    endpoints: [ep("cold", 0.0), ep("proven", 1.0)],
  };
  // proven (reliability 1.0 → +25) must outrank cold (0.0) regardless of the bounded learned delta (±8).
  expect(rankEndpointsServer(req).ranked[0].endpoint_id).toBe("proven");
});

test("deterministic: same request twice → identical scores (pure, no clock/rng)", () => {
  const req: RankRequest = { intent: "list orders", skill_domain: "shop.example", endpoints: [ep("orders"), ep("cart")] };
  const a = rankEndpointsServer(req).ranked.map((r) => [r.endpoint_id, r.score] as const);
  const b = rankEndpointsServer(req).ranked.map((r) => [r.endpoint_id, r.score] as const);
  expect(a).toEqual(b);
});
