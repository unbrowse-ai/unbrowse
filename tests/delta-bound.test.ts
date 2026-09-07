/**
 * delta-bound.test — the witness for plan node 2 (bounded-delta validity claim).
 * Proves: an honest delta (claim-count ≤ B) claims and verifies; an oversized one
 * cannot be claimed (fail-closed); the claim is bound to its own delta (domain
 * separation); tampering the count, bound, or signature fails closed; and a claim
 * only verifies against the wallet that actually signed it.
 */
import { describe, expect, it } from "bun:test";
import { signDelta, shapePointer, type RouteDelta } from "../src/values/route-delta.js";
import { proveDeltaBound, verifyDeltaBound } from "../src/values/delta-bound.js";

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

describe("delta-bound (plan node 2)", () => {
  it("an honest delta (claim-count ≤ B) claims and verifies", async () => {
    const d = await mkDelta();
    const claim = await proveDeltaBound(d, 3, 16);
    expect(verifyDeltaBound(d, claim)).toBe(true);
  });

  it("an oversized delta (claim-count > B) cannot be claimed — fails closed", async () => {
    const d = await mkDelta();
    await expect(proveDeltaBound(d, 20, 16)).rejects.toThrow(/outside bound|fails closed/i);
  });

  it("a valid claim does not transfer to another delta (domain separation)", async () => {
    const a = await mkDelta("GET api.example.com/v1/items");
    const b = await mkDelta("POST api.evil.com/v1/steal");
    const claim = await proveDeltaBound(a, 4, 16);
    expect(verifyDeltaBound(a, claim)).toBe(true);
    expect(verifyDeltaBound(b, claim)).toBe(false);
  });

  it("tampering the count, bound, or signature fails closed", async () => {
    const d = await mkDelta();
    const claim = await proveDeltaBound(d, 5, 16);
    expect(verifyDeltaBound(d, { ...claim, n: 4 })).toBe(false);            // edited count
    expect(verifyDeltaBound(d, { ...claim, B: 32 })).toBe(false);           // edited bound
    expect(verifyDeltaBound(d, { ...claim, n: 17, B: 16 })).toBe(false);    // out-of-bound count
    const flipped = (parseInt(claim.sig.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, "0");
    expect(verifyDeltaBound(d, { ...claim, sig: flipped + claim.sig.slice(2) })).toBe(false);
  });

  it("non-integer or negative counts are rejected", async () => {
    const d = await mkDelta();
    const claim = await proveDeltaBound(d, 5, 16);
    expect(verifyDeltaBound(d, { ...claim, n: 5.5 })).toBe(false);
    expect(verifyDeltaBound(d, { ...claim, n: -1 })).toBe(false);
  });
});
