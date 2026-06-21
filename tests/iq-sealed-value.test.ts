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
import { sealForWallet, revealForWallet, sealValueOnChain, revealValueOnChain, type SignMessage, type OnChainIO } from "../src/values/iq-sealed-value.js";

/** In-memory stand-in for the on-chain inscription store (no chain, no SOL). */
function memIO(): OnChainIO & { store: Map<string, string> } {
  const store = new Map<string, string>();
  let n = 0;
  return {
    store,
    async codeIn(data) { const sig = `tx_${n++}`; store.set(sig, data); return sig; },
    async readCodeIn(txSig) { return { data: store.get(txSig) ?? null }; },
  };
}

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

test("on-chain wrappers: seal→store→read→reveal round-trips for the bound wallet; foreign wallet cannot", async () => {
  const io = memIO();
  const a = Keypair.generate(), b = Keypair.generate();
  const value = "durable-contract-value::v1";
  const txSig = await sealValueOnChain(crypto, signerFor(a), io, value);
  expect(io.store.has(txSig)).toBe(true);
  expect(io.store.get(txSig)).not.toContain("durable-contract-value"); // stored sealed, not plaintext

  expect(await revealValueOnChain(crypto, signerFor(a), io, txSig)).toBe(value);

  let leaked = false;
  try { leaked = (await revealValueOnChain(crypto, signerFor(b), io, txSig)) === value; } catch { leaked = false; }
  expect(leaked).toBe(false);
});

test("revealValueOnChain throws (never silently empties) when the blob is missing", async () => {
  const io = memIO();
  await expect(revealValueOnChain(crypto, signerFor(Keypair.generate()), io, "tx_missing")).rejects.toThrow(/not found on-chain/);
});
