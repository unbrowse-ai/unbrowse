/**
 * Witness for the BROWSER reveal half of crypto-was-all-you-needed (Phase 4 core): a value
 * sealed SERVER-SIDE with the IQ SDK scheme decrypts in the browser lib byte-for-byte, and
 * ONLY for the bound wallet. This is the load-bearing correctness of the reveal surface — if
 * the two crypto paths drift, a deployed page would show nothing. Hermetic: real IQ crypto
 * (the sealer) + the frontend lib (the revealer) + tweetnacl wallet signatures. No chain.
 */
import { test, expect } from "bun:test";
import iq from "@iqlabs-official/solana-sdk";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { revealForWallet, type SignMessage, type SealedEnvelope } from "./wallet-seal-reveal";

const crypto = (iq as any).default?.crypto ?? (iq as any).crypto;
const signerFor = (kp: Keypair): SignMessage => async (msg) => nacl.sign.detached(msg, kp.secretKey);

/** Seal a value to a wallet using the SERVER-SIDE IQ SDK scheme (what the backend produces). */
async function sealServerSide(sign: SignMessage, value: string): Promise<SealedEnvelope> {
  const { pubKey } = await crypto.deriveX25519Keypair(sign);
  const enc = await crypto.dhEncrypt(crypto.bytesToHex(pubKey), new TextEncoder().encode(value));
  return { senderPub: enc.senderPub, iv: enc.iv, ciphertext: enc.ciphertext };
}

test("a server-sealed value is revealed in the browser lib by the bound wallet (byte-compatible)", async () => {
  const owner = Keypair.generate();
  const value = "contract-terms::rendered-only-in-the-browser-by-the-owner::v1";

  const env = await sealServerSide(signerFor(owner), value);
  const rendered = await revealForWallet(signerFor(owner), env);
  expect(rendered).toBe(value); // the two independent crypto paths agree exactly
});

test("a DIFFERENT wallet cannot reveal it (the wallet-gate holds client-side)", async () => {
  const owner = Keypair.generate();
  const intruder = Keypair.generate();
  const env = await sealServerSide(signerFor(owner), "secret-for-owner-only");

  let leaked = false;
  try { leaked = (await revealForWallet(signerFor(intruder), env)) === "secret-for-owner-only"; } catch { leaked = false; }
  expect(leaked).toBe(false);
});
