import { describe, expect, it } from "bun:test";

import {
  generateBase58Keypair,
  keypairFromBase58PrivateKey,
  signEd25519MessageBase58,
} from "../src/solana/solana-helpers.js";

describe("solana helpers", () => {
  it("generates and decodes base58 keypairs without web3 runtime", async () => {
    const generated = await generateBase58Keypair();
    const parsed = await keypairFromBase58PrivateKey(generated.privateKeyB58);

    expect(parsed.publicKey.toBase58()).toBe(generated.publicKey);
    expect(parsed.secretKey.length).toBe(64);
  });

  it("accepts 32-byte seed private keys", async () => {
    const generated = await generateBase58Keypair();
    const parsed = await keypairFromBase58PrivateKey(generated.privateKeyB58);
    const { base58 } = await import("@scure/base");

    const seedB58 = base58.encode(parsed.secretKey.slice(0, 32));
    const fromSeed = await keypairFromBase58PrivateKey(seedB58);

    expect(fromSeed.publicKey.toBase58()).toBe(parsed.publicKey.toBase58());
  });

  it("signs message and returns base58 signature", async () => {
    const generated = await generateBase58Keypair();
    const signature = await signEd25519MessageBase58({
      privateKeyB58: generated.privateKeyB58,
      message: "unbrowse:publish:1234567890",
    });

    expect(typeof signature).toBe("string");
    expect(signature.length).toBeGreaterThan(40);
  });
});
