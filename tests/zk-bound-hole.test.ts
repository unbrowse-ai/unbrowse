/**
 * zk-bound-hole.test — the witness for binding a hole to the wallet with real ZK
 * (src/capture/zk-bound-hole.ts). Proves: the binding carries no secret; the backend
 * confirms the slot is wallet-attested without the secret; the holder proves it
 * knows the bound secret (the secret never transmitted); a wrong secret or a forged
 * binding is rejected.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { bindHole, verifyHoleAttested, proveHole, verifyHoleProof, boundTag } from "../src/capture/zk-bound-hole.js";
import { bind } from "../src/values/zk-binding.js";
import type { Hole } from "../src/capture/hole-template.js";

const enc = (s: string) => new TextEncoder().encode(s);
const SECRET = "Bearer REMOVED_STRIPE_KEY";
const baseHole: Hole = { location: { kind: "header", name: "authorization" } as Hole["location"], name: "authorization", kind: "secret", fill: "vault" };

describe("zk-bound-hole", () => {
  it("binds a hole carrying NO secret", async () => {
    const h = await bindHole(baseHole, enc(SECRET));
    expect(h.bound).toBeTruthy();
    expect(h.bound).not.toContain("sk_live");      // commitment-bound: secret never in the tag
    expect(h.bound).not.toContain("BOUND_HOLE");
  });

  it("the BACKEND confirms the slot is wallet-attested without the secret", async () => {
    const h = await bindHole(baseHole, enc(SECRET));
    expect(verifyHoleAttested(h)).toBe(true);
    expect(verifyHoleAttested(baseHole)).toBe(false);  // an unbound hole is not attested
  });

  it("the HOLDER proves knowledge of the bound secret; the secret never transmitted", async () => {
    const h = await bindHole(baseHole, enc(SECRET));
    expect(verifyHoleProof(h, proveHole(enc(SECRET)))).toBe(true);
    // a WRONG secret cannot produce a passing proof
    expect(verifyHoleProof(h, proveHole(enc("Bearer WRONG")))).toBe(false);
  });

  it("a forged binding (random wallet signature) is rejected", async () => {
    const real = await bind(enc(SECRET));
    const forged: Hole = { ...baseHole, bound: boundTag({ ...real, sig: Buffer.from(randomBytes(64)).toString("hex") }) };
    expect(verifyHoleAttested(forged)).toBe(false);
    expect(verifyHoleProof(forged, proveHole(enc(SECRET)))).toBe(false);
  });
});
