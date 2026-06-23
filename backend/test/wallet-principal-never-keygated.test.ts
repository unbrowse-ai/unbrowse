/**
 * Witness: the route-graph identity is NEVER key-gated — web3-native primary, web2 wrapper.
 *
 * A VERIFIED wallet signature with NO bound api-key must authenticate as a first-class
 * principal (`wallet:<pubkey>`), so the resolve/route-graph path leaves anonymous tier on
 * a wallet signature ALONE. The api-key binding is the optional web2 continuity wrapper.
 * RED controls prove the gate still bites: a forged signature and a stale timestamp are
 * both rejected (null) — never-key-gated is not no-auth.
 */
import { test, expect } from "bun:test";
import { authBySignature, authChallenge } from "../src/services/auth-signature.js";

const ENV = { ENVIRONMENT: "local-dev" } as Record<string, unknown>;

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function freshWallet() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, pubHex: toHex(raw) };
}

async function sign(kp: CryptoKeyPair, msg: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(msg)));
  return toHex(sig);
}

test("web3-native: a verified wallet sig with NO bound key IS a principal (wallet:<pk>) — never key-gated", async () => {
  const { kp, pubHex } = await freshWallet();
  const ts = new Date().toISOString();
  const sigHex = await sign(kp, authChallenge(pubHex, ts));
  const res = await authBySignature(ENV as never, { pubkeyHex: pubHex, ts, sigHex });
  expect(res).not.toBeNull();
  expect(res!.agent_id).toBe(`wallet:${pubHex.toLowerCase()}`); // the wallet IS the account
});

test("RED control: a forged signature is rejected (null) — the gate still bites", async () => {
  const { pubHex } = await freshWallet();
  const ts = new Date().toISOString();
  const res = await authBySignature(ENV as never, { pubkeyHex: pubHex, ts, sigHex: "00".repeat(64) });
  expect(res).toBeNull();
});

test("RED control: a stale timestamp is rejected (replay window) — null", async () => {
  const { kp, pubHex } = await freshWallet();
  const ts = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min old (> AUTH_TTL_MS)
  const sigHex = await sign(kp, authChallenge(pubHex, ts));
  const res = await authBySignature(ENV as never, { pubkeyHex: pubHex, ts, sigHex });
  expect(res).toBeNull();
});
