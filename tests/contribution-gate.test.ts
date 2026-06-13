/**
 * contribution-gate.test — the witness for plan node 5 (validation-registry gate).
 * Proves end-to-end: a proven contribution is validated, merged, and recorded for
 * settlement; a forged contribution is rejected at the gate (never recorded, never earns);
 * the contributor share of an execution is paid to the verified winner only.
 */
import { describe, expect, it } from "bun:test";
import { signDelta, shapePointer } from "../src/values/route-delta.js";
import { proveDeltaValidity } from "../src/values/delta-proof.js";
import { attestExecution } from "../src/capture/exec-attest.js";
import { emptyGraph, type Contribution } from "../backend/src/services/graph-merge/index.js";
import {
  emptyLedger, submitContribution, settleContributorShare,
} from "../backend/src/routes/contribution.js";

async function proven(host: string, path: string, freshness: number): Promise<Contribution> {
  const delta = await signDelta({
    op: "add",
    endpoint: `GET ${host}${path}`,
    shape: shapePointer({ method: "GET", host, path, paramKeys: ["page"] }),
    freshness,
  });
  const validity = proveDeltaValidity(delta, 3, 16);
  const attestation = await attestExecution({ origin: `https://${host}`, method: "GET", shapeHash: delta.shape });
  return { delta, validity, attestation };
}

describe("contribution-gate (plan node 5)", () => {
  it("a proven contribution is validated, merged, and recorded with a root", async () => {
    const g = emptyGraph(), ledger = emptyLedger();
    const c = await proven("api.example.com", "/v1/items", 1000);
    const r = submitContribution(g, ledger, c);
    expect(r.admitted).toBe(true);
    expect(r.contributor).toBe(c.delta.walletRoot);
    expect(r.graphRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.records.length).toBe(1);
  });

  it("a forged contribution is rejected end-to-end: never recorded, never earns", async () => {
    const g = emptyGraph(), ledger = emptyLedger();
    const good = await proven("api.example.com", "/v1/items", 1000);
    const other = await proven("api.example.com", "/v1/other", 1000);
    const forged: Contribution = { ...good, validity: other.validity }; // proof for a different delta
    const r = submitContribution(g, ledger, forged);
    expect(r.admitted).toBe(false);
    expect(ledger.records.length).toBe(0);
    // nothing was admitted ⇒ no one earns on this endpoint
    expect(settleContributorShare(g, "GET api.example.com/v1/items", 10)).toBeNull();
  });

  it("the contributor share of an execution is paid to the verified winner only", async () => {
    const g = emptyGraph(), ledger = emptyLedger();
    const c = await proven("api.example.com", "/v1/items", 1000);
    submitContribution(g, ledger, c);
    const split = settleContributorShare(g, "GET api.example.com/v1/items", 10, 1500);
    expect(split).not.toBeNull();
    expect(split!.contributor).toBe(c.delta.walletRoot);
    expect(split!.amountUsd).toBeCloseTo(1.5, 9); // 15% of $10
  });

  it("a fresher proven contribution becomes the new earner; a forged one cannot displace it", async () => {
    const g = emptyGraph(), ledger = emptyLedger();
    const v1 = await proven("api.example.com", "/v1/items", 1000);
    const v2 = await proven("api.example.com", "/v1/items", 2000); // fresher, same route
    submitContribution(g, ledger, v1);
    expect(submitContribution(g, ledger, v2).admitted).toBe(true);
    const winnerSplit = settleContributorShare(g, "GET api.example.com/v1/items", 10, 1500);
    expect(winnerSplit!.contributor).toBe(v2.delta.walletRoot);
    // a forged attempt to take the route is rejected and the verified winner is unchanged
    const forged: Contribution = { ...v2, attestation: { ...v2.attestation, origin: "https://api.evil.com" } };
    expect(submitContribution(g, ledger, forged).admitted).toBe(false);
    expect(settleContributorShare(g, "GET api.example.com/v1/items", 10, 1500)!.contributor).toBe(v2.delta.walletRoot);
  });
});
