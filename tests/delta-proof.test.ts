/**
 * delta-proof.test — the witness for plan node 2 (bounded-delta validity proof).
 * Proves: an honest delta (claim-count ≤ B) verifies; an oversized one cannot be proven
 * (fail-closed); a fully-simulated forgery with no real opening is rejected (OR-soundness);
 * the proof is bound to its own delta (domain separation); tamper fails closed; and the
 * proof is zero-knowledge (re-randomised, the count never appears).
 */
import { describe, expect, it } from "bun:test";
import { signDelta, shapePointer, type RouteDelta } from "../src/values/route-delta.js";
import { proveDeltaValidity, verifyDeltaValidity, __test } from "../src/values/delta-proof.js";
import { GROUP, modPow, groupRandomScalar } from "../src/values/zk-binding.js";

const { P } = GROUP;
const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m;

async function mkDelta(endpoint = "GET api.example.com/v1/items"): Promise<RouteDelta> {
  const [method, target] = endpoint.split(" ");
  const [host, ...pathParts] = target.split("/");
  return signDelta({
    op: "add",
    endpoint,
    // shape is derived from the endpoint, so distinct routes have distinct shapes
    shape: shapePointer({ method, host, path: "/" + pathParts.join("/"), paramKeys: ["page"] }),
    freshness: 1_700_000_000_000,
  });
}

describe("delta-proof (plan node 2)", () => {
  it("an honest delta (claim-count ≤ B) proves and verifies", async () => {
    const d = await mkDelta();
    const proof = proveDeltaValidity(d, 3, 16);
    expect(verifyDeltaValidity(d, proof)).toBe(true);
  });

  it("an oversized delta (claim-count > B) cannot be proven — fails closed", async () => {
    const d = await mkDelta();
    expect(() => proveDeltaValidity(d, 20, 16)).toThrow(/outside bound|fails closed/i);
  });

  it("a fully-simulated forgery with no real opening is rejected (OR-soundness)", async () => {
    const d = await mkDelta();
    const B = 16;
    const ctx = __test.deltaCtx(d.shape, d.walletRoot, B);
    // Attacker commits to an OUT-OF-RANGE count (20) and simulates EVERY branch: each
    // branch equation holds, but the branch challenges were fixed before the FS hash, so
    // they cannot sum to it without a real opening in [0,B].
    const C = __test.commit(20n, groupRandomScalar());
    const ts: string[] = [], ss: string[] = [], es: string[] = [];
    for (let i = 0; i <= B; i++) {
      const ei = groupRandomScalar(), si = groupRandomScalar();
      const Yi = mod(C * modPow(__test.G_INV, BigInt(i), P), P);
      const YiNegE = modPow(modPow(Yi, ei, P), P - 2n, P);
      const ti = mod(modPow(__test.H, si, P) * YiNegE, P);
      ts.push(ti.toString(16)); ss.push(si.toString(16)); es.push(ei.toString(16));
    }
    const forged = { C: C.toString(16), B, ts, ss, es };
    expect(__test.orVerifyInRange(forged, ctx)).toBe(false);
  });

  it("a valid proof does not transfer to another delta (domain separation)", async () => {
    const a = await mkDelta("GET api.example.com/v1/items");
    const b = await mkDelta("POST api.evil.com/v1/steal");
    const proof = proveDeltaValidity(a, 4, 16);
    expect(verifyDeltaValidity(a, proof)).toBe(true);
    expect(verifyDeltaValidity(b, proof)).toBe(false);
  });

  it("tampering any branch element fails closed", async () => {
    const d = await mkDelta();
    const proof = proveDeltaValidity(d, 5, 16);
    const bump = (s: string): string => (BigInt("0x" + s) + 1n).toString(16);
    expect(verifyDeltaValidity(d, { ...proof, C: bump(proof.C) })).toBe(false);
    expect(verifyDeltaValidity(d, { ...proof, ts: [bump(proof.ts[0]), ...proof.ts.slice(1)] })).toBe(false);
    expect(verifyDeltaValidity(d, { ...proof, ss: [...proof.ss.slice(0, -1), bump(proof.ss.at(-1)!)] })).toBe(false);
    expect(verifyDeltaValidity(d, { ...proof, es: [bump(proof.es[0]), ...proof.es.slice(1)] })).toBe(false);
  });

  it("is zero-knowledge: re-randomised each run, the count never appears", async () => {
    const d = await mkDelta();
    const p1 = proveDeltaValidity(d, 7, 16);
    const p2 = proveDeltaValidity(d, 7, 16);
    expect(p1.ts.join()).not.toBe(p2.ts.join()); // fresh randomness ⇒ different commitments
    expect(verifyDeltaValidity(d, p1)).toBe(true);
    expect(verifyDeltaValidity(d, p2)).toBe(true);
    expect(JSON.stringify(p1)).not.toContain('"7"'); // the secret count is not a field
  });
});
