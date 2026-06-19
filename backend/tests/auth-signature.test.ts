/**
 * Witness: signature-based agent auth (web3-PK root). A real ed25519 keypair signs
 * the domain-separated challenge; the resolver must accept the golden path and
 * REJECT the edges — stale (replay), unbound pubkey, tampered sig, wrong domain.
 *   bun test backend/tests/auth-signature.test.ts
 */
import { describe, it, expect } from "bun:test";
import { authBySignature, authChallenge, verifyEd25519 } from "../src/services/auth-signature.js";
import { generateLocalKey, setKeyWallet } from "../src/services/keys.js";
import type { Env } from "../src/types.js";

const env = { ENVIRONMENT: "local-dev" } as unknown as Env;
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function freshWallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pubkeyHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (msg: string) =>
    toHex(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(msg))));
  return { pubkeyHex, sign };
}

describe("signature-auth (web3-PK root) — golden + adversarial edges", () => {
  it("GOLDEN: valid signature + fresh ts + bound pubkey → the SAME agent_id as the key", async () => {
    const { pubkeyHex, sign } = await freshWallet();
    const { keyId } = generateLocalKey();
    await setKeyWallet(env, keyId, pubkeyHex); // the key wraps this PK
    const ts = new Date().toISOString();
    const sigHex = await sign(authChallenge(pubkeyHex, ts));
    const res = await authBySignature(env, { pubkeyHex, ts, sigHex });
    expect(res?.agent_id).toBe(keyId);
  });

  it("EDGE — replay: a signature with a stale timestamp is rejected", async () => {
    const { pubkeyHex, sign } = await freshWallet();
    const { keyId } = generateLocalKey();
    await setKeyWallet(env, keyId, pubkeyHex);
    const staleTs = new Date(Date.now() - 5 * 60_000).toISOString(); // 5 min old
    const sigHex = await sign(authChallenge(pubkeyHex, staleTs));
    expect(await authBySignature(env, { pubkeyHex, ts: staleTs, sigHex })).toBeNull();
  });

  it("EDGE — unbound: a valid signature for a pubkey no key has bound → null", async () => {
    const { pubkeyHex, sign } = await freshWallet(); // never setKeyWallet'd
    const ts = new Date().toISOString();
    const sigHex = await sign(authChallenge(pubkeyHex, ts));
    expect(await authBySignature(env, { pubkeyHex, ts, sigHex })).toBeNull();
  });

  it("ADVERSARIAL — tampered: a wrong/forged signature is rejected", async () => {
    const { pubkeyHex } = await freshWallet();
    const { keyId } = generateLocalKey();
    await setKeyWallet(env, keyId, pubkeyHex);
    const ts = new Date().toISOString();
    const forged = "00".repeat(64);
    expect(await authBySignature(env, { pubkeyHex, ts, sigHex: forged })).toBeNull();
  });

  it("ADVERSARIAL — cross-protocol: a signature over a non-auth message is rejected", async () => {
    const { pubkeyHex, sign } = await freshWallet();
    const { keyId } = generateLocalKey();
    await setKeyWallet(env, keyId, pubkeyHex);
    const ts = new Date().toISOString();
    const sigOverOtherMsg = await sign(`some-other-domain:${pubkeyHex}:${ts}`); // not the auth domain
    expect(await authBySignature(env, { pubkeyHex, ts, sigHex: sigOverOtherMsg })).toBeNull();
    // sanity: the same bytes DO verify under their own message (proves the keypair works)
    expect(await verifyEd25519(pubkeyHex, `some-other-domain:${pubkeyHex}:${ts}`, sigOverOtherMsg)).toBe(true);
  });
});
