/**
 * wallet-bind — each obfuscated secret is BOUND to the owner's wallet identity.
 *
 * Proves the secular foundation of "any key/value bound to their wallet, only
 * for them to use" (the layer the whitepaper's ZK later strengthens):
 *   1. the binding HIDES the secret (a commitment, never the value),
 *   2. it BINDS to the wallet (a different wallet -> a different tag),
 *   3. only who holds the secret can OPEN it (`verifyBinding`),
 *   4. an obfuscated capture carries wallet-bound tags the owner can verify,
 *      while no secret value survives.
 */
import { describe, it, expect } from "bun:test";
import { bindSecretToWallet, bindingTag, verifyBinding } from "../src/capture/wallet-bind.js";
import { obfuscateCaptureForReveng } from "../src/capture/obfuscate.js";
import type { RawRequest } from "../src/capture/index.js";

const WALLET_A = "8xKpQ2rZvN1mYwTcLdGhJ4sBnEfAuVoPxRgQ7WkMnHj"; // base58-ish Solana pubkey
const WALLET_B = "3aNbCdEfGhJkLmNpQrStUvWxYz123456789ABCDEFGH";
const SECRET = "sk-proj-AbCdEf0123456789AbCdEf0123456789";

describe("bindSecretToWallet — hides, binds, opens", () => {
  it("is deterministic for the same (secret, wallet)", () => {
    expect(bindSecretToWallet(SECRET, WALLET_A)).toBe(bindSecretToWallet(SECRET, WALLET_A));
  });

  it("HIDES the secret (the tag is not, and does not contain, the value)", () => {
    const tag = bindSecretToWallet(SECRET, WALLET_A);
    expect(tag).not.toBe(SECRET);
    expect(tag.includes(SECRET)).toBe(false);
    expect(SECRET.includes(tag)).toBe(false);
    expect(/^[0-9a-f]{64}$/.test(tag)).toBe(true); // opaque sha256 hex
  });

  it("BINDS to the wallet (a different wallet yields a different tag)", () => {
    expect(bindSecretToWallet(SECRET, WALLET_A)).not.toBe(bindSecretToWallet(SECRET, WALLET_B));
  });

  it("a different secret yields a different tag", () => {
    expect(bindSecretToWallet(SECRET, WALLET_A)).not.toBe(bindSecretToWallet(SECRET + "x", WALLET_A));
  });

  it("only who holds the secret can OPEN the binding", () => {
    const tag = bindingTag(SECRET, WALLET_A);
    expect(verifyBinding(SECRET, WALLET_A, tag)).toBe(true);          // owner, right secret
    expect(verifyBinding("wrong-secret", WALLET_A, tag)).toBe(false); // wrong secret
    expect(verifyBinding(SECRET, WALLET_B, tag)).toBe(false);         // wrong wallet
    // full-length commitment opens too
    expect(verifyBinding(SECRET, WALLET_A, bindSecretToWallet(SECRET, WALLET_A))).toBe(true);
  });

  it("requires both inputs (no empty binding)", () => {
    expect(() => bindSecretToWallet("", WALLET_A)).toThrow();
    expect(() => bindSecretToWallet(SECRET, "")).toThrow();
  });
});

const CAP: RawRequest[] = [{
  url: `https://api.example.com/v1/orders?api_key=${SECRET}&page=2`,
  method: "POST",
  request_headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
  request_body: JSON.stringify({ password: "hunter2-very-secret", item_id: 42 }),
  response_status: 200,
  response_headers: { "content-type": "application/json" },
  response_body: JSON.stringify({ access_token: "tok_secret_value_99", order_id: 7788 }),
  timestamp: "2026-06-02T00:00:00Z",
}];

describe("obfuscateCaptureForReveng with a wallet — bound tags, no leak", () => {
  const out = obfuscateCaptureForReveng(CAP, { walletPubkey: WALLET_A });
  const blob = JSON.stringify(out);

  it("emits wallet-bound tags, not flat [REDACTED]", () => {
    expect(blob).toContain("bound:");
    expect(blob).not.toContain("[REDACTED]"); // every redaction is wallet-bound now
  });

  it("no secret value survives", () => {
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toContain("hunter2");
    expect(blob).not.toContain("tok_secret_value_99");
  });

  it("the owner can VERIFY the auth-header secret is bound to their wallet", () => {
    const authTag = out[0]!.request_headers!.authorization!; // `[bound:...]`
    const inner = authTag.replace(/^\[|\]$/g, "");           // strip the [] -> `bound:...`
    expect(verifyBinding(`Bearer ${SECRET}`, WALLET_A, inner)).toBe(true);
    expect(verifyBinding(`Bearer ${SECRET}`, WALLET_B, inner)).toBe(false); // not B's
  });

  it("a different owner's wallet produces different tags for the same capture", () => {
    const outB = obfuscateCaptureForReveng(CAP, { walletPubkey: WALLET_B });
    expect(JSON.stringify(outB)).not.toBe(blob);
    expect(outB[0]!.request_headers!.authorization).not.toBe(out[0]!.request_headers!.authorization);
  });

  it("without a wallet, falls back to flat [REDACTED] (backward compatible)", () => {
    const plain = obfuscateCaptureForReveng(CAP);
    const pblob = JSON.stringify(plain);
    expect(pblob).toContain("[REDACTED]");
    expect(pblob).not.toContain("bound:");
    expect(pblob).not.toContain(SECRET);
  });
});
