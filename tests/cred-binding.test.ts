/**
 * cred-binding.test — the witness for wallet-bound credential binding
 * (src/values/cred-binding.ts): prove a credential is bound to the wallet
 * WITHOUT revealing the credential. Proves: the proof round-trips; the
 * credential never appears in y or the proof (one-way derivation); a wrong
 * credential / tampered proof / tampered binding all FAIL (fails closed); and
 * the binding is to the REAL wallet (a forged signature is rejected).
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  bind, prove, verifyBinding, verifyPok, bindingPubkey, isProvableBindingPoint, type Proof,
} from "../src/values/cred-binding.js";

const enc = (s: string) => new TextEncoder().encode(s);
const CRED = "session=sk_live_SUPER_SECRET_CREDENTIAL_9f8e7d";

describe("credential binding", () => {
  it("proof of knowledge round-trips against the public commitment", () => {
    const y = bindingPubkey(enc(CRED));
    expect(verifyPok(y, prove(enc(CRED)))).toBe(true);
  });

  it("SECRECY: the credential never appears in y or the proof", () => {
    const y = bindingPubkey(enc(CRED));
    const p: Proof = prove(enc(CRED), enc("ctx-domain"));
    const blob = y + JSON.stringify(p);
    expect(blob).not.toContain("SUPER_SECRET");
    expect(blob).not.toContain("sk_live");
    // the credential bytes are also never emitted hex-encoded
    expect(blob).not.toContain(Buffer.from(CRED).toString("hex"));
  });

  it("a WRONG credential cannot open the binding", () => {
    const y = bindingPubkey(enc(CRED));
    expect(verifyPok(y, prove(enc("session=WRONG")))).toBe(false);     // other cred's proof
    const yOther = bindingPubkey(enc("session=WRONG"));
    expect(verifyPok(yOther, prove(enc(CRED)))).toBe(false);           // proof vs other point
  });

  it("a tampered proof fails (fails closed)", () => {
    const y = bindingPubkey(enc(CRED));
    const p = prove(enc(CRED));
    const flipped = (parseInt(p.sig.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, "0");
    const bad: Proof = { ...p, sig: flipped + p.sig.slice(2) };
    expect(verifyPok(y, bad)).toBe(false);
  });

  it("the proof is bound to its ctx (a swapped ctx fails)", () => {
    const y = bindingPubkey(enc(CRED));
    const p = prove(enc(CRED), enc("ctx-A"));
    const swapped: Proof = { ...p, ctx: Buffer.from("ctx-B").toString("hex") };
    expect(verifyPok(y, swapped)).toBe(false);
  });

  it("binds to the REAL wallet: bind+prove verifies; tampered binding is rejected", async () => {
    const binding = await bind(enc(CRED));
    expect(binding.root.length).toBe(64);                 // 32-byte ed25519 pubkey hex
    expect(isProvableBindingPoint(binding.y)).toBe(true); // y = derived pubkey, 64 hex
    expect(verifyBinding(binding, prove(enc(CRED)))).toBe(true);

    // tamper the signed point → wallet signature no longer matches
    const tamperedY = { ...binding, y: bindingPubkey(enc("session=WRONG")) };
    expect(verifyBinding(tamperedY, prove(enc(CRED)))).toBe(false);

    // forge the signature with random bytes → rejected
    const forged = { ...binding, sig: Buffer.from(randomBytes(64)).toString("hex") };
    expect(verifyBinding(forged, prove(enc(CRED)))).toBe(false);
  });

  it("the commitment is deterministic (same credential → same y)", () => {
    expect(bindingPubkey(enc(CRED))).toBe(bindingPubkey(enc(CRED)));
  });

  it("legacy MODP points are recognized as non-provable", () => {
    expect(isProvableBindingPoint("ab".repeat(256))).toBe(false); // 512-hex legacy point
    expect(isProvableBindingPoint("not-hex")).toBe(false);
  });
});
