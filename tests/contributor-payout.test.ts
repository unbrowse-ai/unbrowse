/**
 * contributor-payout.test — the witness for plan node 4 (four-way split + contributor leg).
 * Proves: the four legs sum to the charge (with and without a contributor); the contributor
 * leg is paid to the verified graph winner; a non-winner / forged contributor earns nothing
 * (platform absorbs the unattributed leg); and a malformed split is rejected.
 */
import { describe, expect, it } from "bun:test";
import { signDelta, shapePointer } from "../src/values/route-delta.js";
import { proveDeltaValidity } from "../src/values/delta-proof.js";
import { attestExecution } from "../src/capture/exec-attest.js";
import { emptyGraph, type Contribution } from "../backend/src/services/graph-merge/index.js";
import {
  emptyLedger, submitContribution, settleExecution, DEFAULT_SPLIT,
} from "../backend/src/routes/contribution.js";

async function proven(host: string, path: string, freshness: number): Promise<Contribution> {
  const delta = await signDelta({
    op: "add",
    endpoint: `GET ${host}${path}`,
    shape: shapePointer({ method: "GET", host, path }),
    freshness,
  });
  return {
    delta,
    validity: proveDeltaValidity(delta, 3, 16),
    attestation: await attestExecution({ origin: `https://${host}`, method: "GET", shapeHash: delta.shape }),
  };
}

const sumLegs = (s: ReturnType<typeof settleExecution>) =>
  s.platform + s.owner + s.contributor.amountUsd + s.discoverer;

describe("contributor-payout (plan node 4)", () => {
  it("the four legs sum to the charge and pay the verified winner the contributor leg", async () => {
    const g = emptyGraph(), ledger = emptyLedger();
    const c = await proven("api.example.com", "/v1/items", 1000);
    submitContribution(g, ledger, c);
    const s = settleExecution(g, "GET api.example.com/v1/items", 10);
    expect(sumLegs(s)).toBeCloseTo(10, 9);
    expect(s.contributor.recipient).toBe(c.delta.walletRoot);
    expect(s.contributor.amountUsd).toBeCloseTo(1.5, 9);   // 15% contributor
    expect(s.owner).toBeCloseTo(5, 9);                      // 50% owner
  });

  it("with no verified contributor: leg is 0, platform absorbs it, legs still sum", () => {
    const g = emptyGraph();
    const s = settleExecution(g, "GET api.unseen.com/v1/x", 10);
    expect(s.contributor.recipient).toBeNull();
    expect(s.contributor.amountUsd).toBe(0);
    expect(s.platform).toBeCloseTo(1.5 + 1.5, 9);           // platform 15% + absorbed contributor 15%
    expect(sumLegs(s)).toBeCloseTo(10, 9);
  });

  it("a forged contribution earns nothing; settlement pays the real verified winner", async () => {
    const g = emptyGraph(), ledger = emptyLedger();
    const real = await proven("api.example.com", "/v1/items", 1000);
    submitContribution(g, ledger, real);
    // a forged attempt to take the same route (origin≠endpoint host) is rejected at the gate
    const forged: Contribution = { ...real, attestation: { ...real.attestation, origin: "https://api.attacker.com" } };
    expect(submitContribution(g, ledger, forged).admitted).toBe(false);
    const s = settleExecution(g, "GET api.example.com/v1/items", 10);
    expect(s.contributor.recipient).toBe(real.delta.walletRoot); // the verified winner, not the forger
    expect(s.contributor.amountUsd).toBeCloseTo(1.5, 9);
  });

  it("a split that does not sum to 10000 bps is rejected", () => {
    const g = emptyGraph();
    expect(() => settleExecution(g, "GET x/y", 10, { ...DEFAULT_SPLIT, platformBps: 9999 })).toThrow(/sum to 10000/);
  });
});
