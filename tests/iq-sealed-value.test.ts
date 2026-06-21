/**
 * Witness for iq-sealed-value (crypto-was-all-you-needed Phase 1): a value sealed to a
 * wallet is revealable ONLY by that wallet. Hermetic — real IQ crypto + tweetnacl in
 * process, no chain (the live codeIn round-trip is proven separately, SEAL_ROUNDTRIP_OK).
 * Two distinct wallets: A seals, A reveals = match; B cannot reveal A's envelope.
 */
import { test, expect } from "bun:test";
import iq from "@iqlabs-official/solana-sdk";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { sealForWallet, revealForWallet, type SignMessage } from "../src/values/iq-sealed-value.js";

const crypto = (iq as any).default?.crypto ?? (iq as any).crypto;
const signerFor = (kp: Keypair): SignMessage => async (msg) => nacl.sign.detached(msg, kp.secretKey);

test("a value sealed to a wallet is revealed only by that same wallet", async () => {
  const walletA = Keypair.generate();
  const signA = signerFor(walletA);
  const secret = "contract-value::only-A-may-render::v1";

  const env = await sealForWallet(crypto, signA, secret);
  // The envelope is opaque — the plaintext is not in it.
  expect(JSON.stringify(env)).not.toContain("only-A-may-render");

  // Wallet A renders it back exactly.
  const revealed = await revealForWallet(crypto, signA, env);
  expect(revealed).toBe(secret);
});

test("a DIFFERENT wallet cannot render the sealed value (wallet-bound auth)", async () => {
  const walletA = Keypair.generate();
  const walletB = Keypair.generate();
  const env = await sealForWallet(crypto, signerFor(walletA), "secret-for-A-only");

  // B's reveal must NOT yield A's plaintext — it throws (bad MAC) or returns garbage.
  let leaked = false;
  try {
    const out = await revealForWallet(crypto, signerFor(walletB), env);
    leaked = out === "secret-for-A-only";
  } catch {
    leaked = false; // decryption refused — the wallet-gate held
  }
  expect(leaked).toBe(false);
});

test("seal is non-deterministic (fresh ephemeral key / iv per seal) but always reveals", async () => {
  const w = Keypair.generate();
  const sign = signerFor(w);
  const e1 = await sealForWallet(crypto, sign, "v");
  const e2 = await sealForWallet(crypto, sign, "v");
  expect(e1.ciphertext === e2.ciphertext && e1.iv === e2.iv).toBe(false); // not a deterministic cipher
  expect(await revealForWallet(crypto, sign, e1)).toBe("v");
  expect(await revealForWallet(crypto, sign, e2)).toBe("v");
});
