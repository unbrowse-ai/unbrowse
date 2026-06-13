/**
 * notary-attest.test — the witness for plan node 2 (pluggable notary attestation carrier).
 * Proves: a notary-carried attestation verifies against a trusted notary; the wallet
 * self-signature path is untouched and independent; an untrusted notary, a tampered notary
 * proof, an origin-swap after notarizing, and a missing notary all fail closed.
 */
import { describe, expect, it } from "bun:test";
import {
  attestExecution, verifyAttestation, referenceNotary, verifyNotary, type ExecAttestation,
} from "../src/capture/exec-attest.js";
import { shapePointer } from "../src/values/route-delta.js";

const SHAPE = shapePointer({ method: "GET", host: "api.example.com", path: "/v1/items" });

async function att(): Promise<ExecAttestation> {
  return attestExecution({ origin: "https://api.example.com", method: "GET", shapeHash: SHAPE });
}

describe("notary attestation carrier (plan node 2)", () => {
  it("a notary-carried attestation verifies against the trusted notary", async () => {
    const notary = referenceNotary();
    const signed = notary.notarize(await att());
    expect(verifyNotary(signed, new Set([notary.pubkey]))).toBe(true);
  });

  it("the wallet self-signature path is untouched and independent of the notary", async () => {
    const notary = referenceNotary();
    const a = await att();
    const signed = notary.notarize(a);
    // wallet sig still verifies on both the bare and the notarized attestation
    expect(verifyAttestation(a, a.walletRoot)).toBe(true);
    expect(verifyAttestation(signed, signed.walletRoot)).toBe(true);
  });

  it("an untrusted notary is rejected", async () => {
    const notary = referenceNotary(), other = referenceNotary();
    const signed = notary.notarize(await att());
    expect(verifyNotary(signed, new Set([other.pubkey]))).toBe(false); // notary not in trusted set
  });

  it("a tampered notary proof fails closed", async () => {
    const notary = referenceNotary();
    const signed = notary.notarize(await att());
    const bad = { ...signed, notary: { ...signed.notary!, sig: (BigInt("0x" + signed.notary!.sig) ^ 1n).toString(16) } };
    expect(verifyNotary(bad, new Set([notary.pubkey]))).toBe(false);
  });

  it("an origin-swap after notarizing fails closed (canon mismatch)", async () => {
    const notary = referenceNotary();
    const signed = notary.notarize(await att());
    const swapped = { ...signed, origin: "https://api.evil.com" };
    expect(verifyNotary(swapped, new Set([notary.pubkey]))).toBe(false);
  });

  it("an attestation with no notary carrier is not notary-verified", async () => {
    const notary = referenceNotary();
    expect(verifyNotary(await att(), new Set([notary.pubkey]))).toBe(false);
  });
});
