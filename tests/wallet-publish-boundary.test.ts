/**
 * wallet-publish-boundary.test — the witness for the public-boundary rule
 * (src/values/wallet-seal.ts publishValue/verifyPublished): the outward complement
 * of sealValue. Only a content-addressed value COPY, signed by the wallet, crosses
 * the public boundary; it is verifiable against the wallet PUBLIC key; the private
 * key never crosses. Production port of paper/reference/layers/key_mobility.py.
 */
import { describe, expect, it } from "bun:test";
import { publishValue, verifyPublished, publishedPub, contentHash } from "../src/values/wallet-seal.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("public boundary: only wallet-signed value copies cross", () => {
  it("publishes a value copy verifiable under the wallet public key", async () => {
    const data = enc("balance=42");
    const pub = await publishedPub();
    const published = await publishValue(data);
    expect(published.pub).toBe(pub);
    expect(published.contentHash).toBe(contentHash(data));
    expect(verifyPublished(published, pub)).toBe(true);
  });

  it("the private key never crosses — only contentHash, value, pub, sig", async () => {
    const published = await publishValue(enc("alice@id"));
    // The artifact that crosses carries ONLY public material — no private field.
    expect(Object.keys(published).sort()).toEqual(["contentHash", "pub", "sig", "value"]);
    expect(published.pub).toMatch(/^[0-9a-f]{64}$/); // 32-byte pubkey, not a seed
    expect(JSON.stringify(published).toLowerCase()).not.toContain("priv");
  });

  it("what crosses is a COPY — mutating the published value breaks verification", async () => {
    const pub = await publishedPub();
    const published = await publishValue(enc("balance=42"));
    published.value = Buffer.from(enc("balance=999")).toString("hex"); // tamper the copy
    expect(verifyPublished(published, pub)).toBe(false);               // content hash mismatch
  });

  it("a foreign public key cannot verify the copy", async () => {
    const published = await publishValue(enc("alice@id"));
    const foreign = "ab".repeat(32); // 32-byte hex, not the signer
    expect(verifyPublished(published, foreign)).toBe(false);
  });
});
