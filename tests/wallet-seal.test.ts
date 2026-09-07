/**
 * wallet-seal.test — the witness for the production sealed-unless-revealed
 * primitive (src/values/wallet-seal.ts), the privacy floor of the whitepaper's
 * ZK-credential-binding layer (the AES-GCM/encryption half; src/trust/sealed-cache
 * is the complementary commitment half). Proves: sealed bytes leak nothing; only
 * the holding key reveals; wrong key / tamper / relabel all STAY sealed (no
 * fabricated reveal); and the seal binds to the REAL wallet identity.
 */
import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { sealValue, revealValue, contentHash, SealReveal } from "../src/values/wallet-seal.js";

const key = () => new Uint8Array(randomBytes(32));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("wallet sealed-unless-revealed", () => {
  it("seals: at-rest bytes leak nothing of the plaintext", () => {
    const secret = enc("session-cookie=sk_live_DO_NOT_LEAK_42");
    const { hash, sealed } = sealValue(secret, key());
    expect(hash).toBe(contentHash(secret));            // content-addressed by plaintext
    expect(dec(sealed)).not.toContain("DO_NOT_LEAK");  // ciphertext, not plaintext
    expect(sealed.length).toBeGreaterThan(secret.length); // nonce + tag overhead
  });

  it("reveals only under the holding key (round-trip)", () => {
    const k = key();
    const { hash, sealed } = sealValue(enc("Bearer eyJ.padding.value"), k);
    expect(dec(revealValue(hash, sealed, k))).toBe("Bearer eyJ.padding.value");
  });

  it("a DIFFERENT key cannot reveal — the value stays sealed", () => {
    const { hash, sealed } = sealValue(enc("api_key=topsecret"), key());
    expect(() => revealValue(hash, sealed, key())).toThrow(SealReveal); // wrong wallet → sealed
  });

  it("tampered ciphertext fails the GCM tag (fails closed)", () => {
    const k = key();
    const { hash, sealed } = sealValue(enc("withdraw all"), k);
    const bad = new Uint8Array(sealed); bad[bad.length - 1] ^= 0x01; // flip a tag byte
    expect(() => revealValue(hash, bad, k)).toThrow(SealReveal);
  });

  it("a relabelled ciphertext (wrong AAD hash) cannot be revealed", () => {
    const k = key();
    const { sealed } = sealValue(enc("value A"), k);
    const wrongHash = contentHash(enc("value B"));
    expect(() => revealValue(wrongHash, sealed, k)).toThrow(SealReveal);
  });

  it("binds to the REAL wallet identity: deriveSealKey round-trips, a stranger key does not", async () => {
    const { deriveSealKey } = await import("../src/values/signer.js");
    const wk = deriveSealKey();
    expect(wk.length).toBe(32);
    expect(Array.from(deriveSealKey())).toEqual(Array.from(wk)); // deterministic per wallet
    const { hash, sealed } = sealValue(enc("wallet-bound secret"), wk);
    expect(dec(revealValue(hash, sealed, wk))).toBe("wallet-bound secret"); // holder opens
    expect(() => revealValue(hash, sealed, key())).toThrow(SealReveal);     // stranger cannot
  });
});
