/**
 * Witness (end-to-end, two components): the CLI's wallet-auth header builder mints a
 * capability the backend's REAL verifier accepts as a `wallet:<pk>` principal — no api key.
 * This closes the never-key-gated loop: CLI signer → X-Unbrowse-* headers → authBySignature.
 * RED control: a tampered signature is rejected (null) — the gate still bites.
 */
import { test, expect } from "bun:test";
import { walletAuthHeaders } from "../../src/lib/wallet-auth-headers.ts";
import { authBySignature } from "../src/services/auth-signature.js";
import type { ThinClientSigner } from "../../src/lib/contract-thin-client.ts";

const ENV = { ENVIRONMENT: "local-dev" } as Record<string, unknown>;

async function stubSigner(): Promise<ThinClientSigner> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); // 32-byte ed25519 pubkey
  return {
    async getWalletPubkey() {
      return raw;
    },
    async signBytes(message: Uint8Array) {
      const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, message));
      return { signature: sig };
    },
  };
}

test("CLI-minted wallet-auth headers verify against the real backend verifier → wallet:<pk> principal (no key)", async () => {
  const signer = await stubSigner();
  const h = await walletAuthHeaders(signer);
  expect(h).not.toBeNull();
  const res = await authBySignature(ENV as never, {
    pubkeyHex: h!["X-Unbrowse-Wallet"],
    ts: h!["X-Unbrowse-Auth-Ts"],
    sigHex: h!["X-Unbrowse-Signature"],
  });
  expect(res).not.toBeNull();
  expect(res!.agent_id).toBe(`wallet:${h!["X-Unbrowse-Wallet"].toLowerCase()}`);
});

test("RED control: a tampered signature is rejected by the backend (null)", async () => {
  const signer = await stubSigner();
  const h = await walletAuthHeaders(signer);
  // flip the first hex nibble of the signature
  const bad = (h!["X-Unbrowse-Signature"][0] === "0" ? "1" : "0") + h!["X-Unbrowse-Signature"].slice(1);
  const res = await authBySignature(ENV as never, {
    pubkeyHex: h!["X-Unbrowse-Wallet"],
    ts: h!["X-Unbrowse-Auth-Ts"],
    sigHex: bad,
  });
  expect(res).toBeNull();
});
