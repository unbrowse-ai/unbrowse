/**
 * exec-attest.test — the witness for plan node 3 (execution attestation).
 * Proves: an attestation round-trips and binds its delta; an origin-swap, a replay onto a
 * different route, a forged wallet root, and any field tamper all fail closed.
 */
import { describe, expect, it } from "bun:test";
import { signDelta, shapePointer, type RouteDelta } from "../src/values/route-delta.js";
import { attestExecution, verifyAttestation, attestationBindsDelta } from "../src/capture/exec-attest.js";

async function deltaFor(host: string, path: string): Promise<RouteDelta> {
  return signDelta({
    op: "add",
    endpoint: `GET ${host}${path}`,
    shape: shapePointer({ method: "GET", host, path, paramKeys: ["page"] }),
    freshness: 1_700_000_000_000,
  });
}

describe("exec-attest (plan node 3)", () => {
  it("an attestation round-trips and binds its delta", async () => {
    const d = await deltaFor("api.example.com", "/v1/items");
    const att = await attestExecution({ origin: "https://api.example.com", method: "GET", shapeHash: d.shape });
    expect(verifyAttestation(att, att.walletRoot)).toBe(true);
    expect(attestationBindsDelta(att, d)).toBe(true);
  });

  it("an origin-swap fails closed", async () => {
    const d = await deltaFor("api.example.com", "/v1/items");
    const att = await attestExecution({ origin: "https://api.example.com", method: "GET", shapeHash: d.shape });
    const swapped = { ...att, origin: "https://api.evil.com" };
    expect(verifyAttestation(swapped, att.walletRoot)).toBe(false); // sig was over the real origin
  });

  it("cannot be replayed onto a different route (shape/host mismatch)", async () => {
    const a = await deltaFor("api.example.com", "/v1/items");
    const b = await deltaFor("api.example.com", "/v1/orders"); // same host, different shape
    const att = await attestExecution({ origin: "https://api.example.com", method: "GET", shapeHash: a.shape });
    expect(attestationBindsDelta(att, a)).toBe(true);
    expect(attestationBindsDelta(att, b)).toBe(false); // shape pointer differs
    // and a host mismatch also breaks the bind
    const c = await deltaFor("api.other.com", "/v1/items");
    const attC = await attestExecution({ origin: "https://api.example.com", method: "GET", shapeHash: c.shape });
    expect(attestationBindsDelta(attC, c)).toBe(false); // attested origin host ≠ endpoint host
  });

  it("a forged wallet root is rejected", async () => {
    const d = await deltaFor("api.example.com", "/v1/items");
    const att = await attestExecution({ origin: "https://api.example.com", method: "GET", shapeHash: d.shape });
    const forged = "cd".repeat(32);
    expect(verifyAttestation({ ...att, walletRoot: forged }, forged)).toBe(false);
    expect(verifyAttestation(att, forged)).toBe(false);
  });

  it("tampering any signed field fails closed", async () => {
    const d = await deltaFor("api.example.com", "/v1/items");
    const att = await attestExecution({ origin: "https://api.example.com", method: "GET", shapeHash: d.shape });
    expect(verifyAttestation({ ...att, method: "POST" }, att.walletRoot)).toBe(false);
    expect(verifyAttestation({ ...att, shapeHash: "sha256:" + "0".repeat(64) }, att.walletRoot)).toBe(false);
    expect(verifyAttestation({ ...att, capturedAt: att.capturedAt + 1 }, att.walletRoot)).toBe(false);
    expect(verifyAttestation({ ...att, nonce: "00" + att.nonce.slice(2) }, att.walletRoot)).toBe(false);
  });
});
