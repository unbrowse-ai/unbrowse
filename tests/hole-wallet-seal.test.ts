/**
 * Witness: the zk'd hole — protected by the wallet. When the hole is wallet-bound, every
 * request carries a real Ed25519 attestation over the canonical request, and only the
 * holder of the wallet could have produced it (a tampered request fails verification).
 *
 * No stub crypto: a real node:crypto Ed25519 keypair signs and verifies.
 */
import { test, expect } from "bun:test";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { createHole, canonicalRequest, type HoleTransport, type WalletSeal } from "../src/sdk/hole.js";

const stub: HoleTransport = async (req) => ({ ok: true, intent: req.intent, items: [{ url: "https://a/1", text: "x" }] });

const SPKI_PREFIX_LEN = 12; // Ed25519 SPKI prefix; raw pubkey = last 32 bytes
function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A real Ed25519 wallet signer. */
function makeWallet(): { wallet: WalletSeal; verify: (msg: Uint8Array, sigHex: string) => boolean } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const rawPub = new Uint8Array(spki.subarray(spki.length - 32));
  const wallet: WalletSeal = {
    async sign(message: Uint8Array) {
      const signature = new Uint8Array(nodeSign(null, message, privateKey));
      return { signature, walletPubkey: rawPub };
    },
  };
  const verify = (msg: Uint8Array, sigHex: string) => nodeVerify(null, msg, publicKey, hexToBytes(sigHex));
  return { wallet, verify };
}

test("a wallet-bound hole attaches a real, verifiable seal", async () => {
  const { wallet, verify } = makeWallet();
  const hole = createHole({ transport: stub, wallet });
  const req = { intent: "fill this gap", url: "https://target/x" };
  const r = await hole.fill(req);

  expect(r.seal).toBeDefined();
  expect(r.seal!.walletPubkey).toMatch(/^[0-9a-f]{64}$/);
  expect(r.seal!.signature).toMatch(/^[0-9a-f]{128}$/);
  // the seal verifies over the canonical request — proof the holder produced it
  expect(verify(canonicalRequest(req), r.seal!.signature)).toBe(true);
});

test("a tampered request fails verification (only the holder could seal it)", async () => {
  const { wallet, verify } = makeWallet();
  const r = await createHole({ transport: stub, wallet }).fill({ intent: "real intent" });
  // verify the same signature against a DIFFERENT request → must fail
  expect(verify(canonicalRequest({ intent: "forged intent" }), r.seal!.signature)).toBe(false);
});

test("an unsealed hole produces no seal", async () => {
  const r = await createHole({ transport: stub }).fill({ intent: "x" });
  expect(r.seal).toBeUndefined();
});
