/**
 * route-delta.test — the witness for plan node 1 (the contributed unit).
 * Proves: a signed delta round-trips; its id is deterministic; ANY tampered field or a
 * forged root fails closed; a contributor chain verifies and breaks on reorder/edit; and
 * the delta carries the route STRUCTURE only as a hash (no raw capture, no secret).
 */
import { describe, expect, it } from "bun:test";
import {
  signDelta, verifyDelta, verifyDeltaChain, deltaId, shapePointer, type RouteDelta,
} from "../src/values/route-delta.js";

// A secret-stripped route structure (what obfuscateCaptureForReveng would emit) — note
// the literal SECRET token below is a structure marker we assert never reaches the delta.
const STRUCTURE = {
  method: "GET",
  host: "api.example.com",
  path: "/v1/items",
  paramKeys: ["page", "limit"],
  schema: { items: "array" },
  marker: "STRUCTURE_SECRET_NEVER_IN_DELTA_9f8e7d",
};

async function mkDelta(over: Partial<Parameters<typeof signDelta>[0]> = {}) {
  return signDelta({
    op: "add",
    endpoint: "GET api.example.com/v1/items",
    shape: shapePointer(STRUCTURE),
    freshness: 1_700_000_000_000,
    ...over,
  });
}

describe("route-delta (plan node 1)", () => {
  it("a signed delta round-trips against its own wallet root", async () => {
    const d = await mkDelta();
    expect(verifyDelta(d, d.walletRoot)).toBe(true);
  });

  it("deltaId is deterministic and stable for the same delta", async () => {
    const d = await mkDelta();
    expect(deltaId(d)).toBe(deltaId(d));
    expect(deltaId(d)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("any tampered field fails closed", async () => {
    const d = await mkDelta();
    const mutate = (k: keyof RouteDelta, v: unknown): RouteDelta => ({ ...d, [k]: v } as RouteDelta);
    expect(verifyDelta(mutate("op", "supersede"), d.walletRoot)).toBe(false);
    expect(verifyDelta(mutate("endpoint", "GET api.evil.com/v1/items"), d.walletRoot)).toBe(false);
    expect(verifyDelta(mutate("shape", "0".repeat(64)), d.walletRoot)).toBe(false);
    expect(verifyDelta(mutate("freshness", 9_999_999_999_999), d.walletRoot)).toBe(false);
    expect(verifyDelta(mutate("seq", 7), d.walletRoot)).toBe(false);
    expect(verifyDelta(mutate("prev", "deadbeef"), d.walletRoot)).toBe(false);
  });

  it("a forged wallet root is rejected (binding is to the real wallet)", async () => {
    const d = await mkDelta();
    const forged = "ab".repeat(32); // a different 32-byte pubkey hex
    expect(verifyDelta({ ...d, walletRoot: forged }, forged)).toBe(false);
    expect(verifyDelta(d, forged)).toBe(false);
  });

  it("a contributor chain verifies, and reorder / edit breaks it", async () => {
    const d0 = await mkDelta({ seq: 0 });
    const d1 = await mkDelta({ seq: 1, prev: deltaId(d0), endpoint: "POST api.example.com/v1/items" });
    const d2 = await mkDelta({ seq: 2, prev: deltaId(d1), op: "update" });
    const chain = [d0, d1, d2];
    expect(verifyDeltaChain(chain, d0.walletRoot)).toBe(true);
    // reorder → broken chain (prev no longer matches)
    expect(verifyDeltaChain([d0, d2, d1], d0.walletRoot)).toBe(false);
    // edit a past row → its id changes → every later prev breaks
    const tampered = [{ ...d0, freshness: d0.freshness + 1 }, d1, d2];
    expect(verifyDeltaChain(tampered, d0.walletRoot)).toBe(false);
  });

  it("carries the route structure only as a hash — no raw capture, no secret, in the delta", async () => {
    const d = await mkDelta();
    const wire = JSON.stringify(d);
    expect(wire).not.toContain("STRUCTURE_SECRET_NEVER_IN_DELTA_9f8e7d"); // the secret marker
    expect(wire).not.toContain("paramKeys");  // structure keys live in the hash, not raw
    expect(wire).not.toContain("schema");     // ditto
    expect(d.shape).toMatch(/^sha256:[0-9a-f]{64}$/); // shape is a content pointer, not the bytes
  });
});
