/**
 * zk-binding.test — the witness for ZK credential binding (src/values/zk-binding.ts),
 * the whitepaper's central contribution: prove a credential is bound to the wallet
 * WITHOUT revealing the credential. Proves: the proof round-trips; the credential
 * never appears in y or the proof (commitment-bound); a wrong credential / tampered
 * proof / tampered binding all FAIL (fails closed); and the binding is to the REAL
 * wallet (a forged signature is rejected).
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  bind, prove, verifyBinding, verifySchnorr, bindingPoint, credentialScalar, type Proof,
} from "../src/values/zk-binding.js";

const enc = (s: string) => new TextEncoder().encode(s);
const CRED = "session=REMOVED_STRIPE_KEY";

describe("zk credential binding", () => {
  it("proof of knowledge round-trips against the public binding point", () => {
    const y = bindingPoint(enc(CRED)).toString(16);
    expect(verifySchnorr(y, prove(enc(CRED)))).toBe(true);
  });

  it("commitment-bound: the credential never appears in y or the proof", () => {
    const y = bindingPoint(enc(CRED)).toString(16);
    const p: Proof = prove(enc(CRED), enc("ctx-domain"));
    const blob = y + JSON.stringify(p);
    expect(blob).not.toContain("SUPER_SECRET");
    expect(blob).not.toContain("sk_live");
    // x itself is also never emitted
    expect(blob).not.toContain(credentialScalar(enc(CRED)).toString(16));
  });

  it("a WRONG credential cannot open the binding", () => {
    const y = bindingPoint(enc(CRED)).toString(16);
    expect(verifySchnorr(y, prove(enc("session=WRONG")))).toBe(false);     // other cred's proof
    const yOther = bindingPoint(enc("session=WRONG")).toString(16);
    expect(verifySchnorr(yOther, prove(enc(CRED)))).toBe(false);           // proof vs other point
  });

  it("a tampered proof fails (fails closed)", () => {
    const y = bindingPoint(enc(CRED)).toString(16);
    const p = prove(enc(CRED));
    const bad: Proof = { ...p, s: (BigInt("0x" + p.s) + 1n).toString(16) }; // nudge s
    expect(verifySchnorr(y, bad)).toBe(false);
  });

  it("binds to the REAL wallet: bind+prove verifies; tampered binding is rejected", async () => {
    const binding = await bind(enc(CRED));
    expect(binding.root.length).toBe(64);                 // 32-byte ed25519 pubkey hex
    expect(verifyBinding(binding, prove(enc(CRED)))).toBe(true);

    // tamper the signed point → wallet signature no longer matches
    const tamperedY = { ...binding, y: bindingPoint(enc("session=WRONG")).toString(16) };
    expect(verifyBinding(tamperedY, prove(enc(CRED)))).toBe(false);

    // forge the signature with random bytes → rejected
    const forged = { ...binding, sig: Buffer.from(randomBytes(64)).toString("hex") };
    expect(verifyBinding(forged, prove(enc(CRED)))).toBe(false);
  });

  it("the binding point is deterministic (same credential → same y)", () => {
    expect(bindingPoint(enc(CRED)).toString(16)).toBe(bindingPoint(enc(CRED)).toString(16));
  });
});
